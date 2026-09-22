"""Executed in an existing application container as its configured user."""
import hashlib
import json
import os
import stat
import sys
import uuid

ROOT='/app/media/data_hub_raw_media'


def info(st):return {'uid':st.st_uid,'gid':st.st_gid,'mode':oct(stat.S_IMODE(st.st_mode)),'device':st.st_dev,'inode':st.st_ino}


def probe(root, mode, expected_inode):
    if mode not in ('check','probe'):raise RuntimeError('Unsupported permission operation.')
    flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
    fd=os.open(root,flags)
    try:
        result={'uid':os.geteuid(),'gid':os.getegid(),'groups':os.getgroups(),'directory':info(os.fstat(fd)),
                'effective_read':os.access(root,os.R_OK,effective_ids=True),'effective_write':os.access(root,os.W_OK,effective_ids=True),
                'effective_search':os.access(root,os.X_OK,effective_ids=True),'write_test':mode=='probe'}
        if os.fstat(fd).st_ino!=expected_inode:raise RuntimeError('Unexpected media inode.')
        if mode=='check':return result
        name='.mx-static-app-probe-'+uuid.uuid4().hex;child=None;created=None;file_id=None;leaf='payload'
        try:
            os.mkdir(name,0o700,dir_fd=fd)
            created=os.stat(name,dir_fd=fd,follow_symlinks=False)
            child=os.open(name,flags,dir_fd=fd)
            if (os.fstat(child).st_dev,os.fstat(child).st_ino)!=(created.st_dev,created.st_ino):raise RuntimeError('Created probe directory replaced.')
            result['probe_name']=name
            f=os.open(leaf,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=child)
            payload=os.urandom(4096)
            with os.fdopen(f,'wb') as stream:
                file_id=os.fstat(stream.fileno());result['created_file']=info(file_id);stream.write(payload);stream.flush();os.fsync(stream.fileno())
            os.rename('payload','readback',src_dir_fd=child,dst_dir_fd=child);leaf='readback';os.fsync(child)
            f=os.open(leaf,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=child)
            with os.fdopen(f,'rb') as stream:
                st=os.fstat(stream.fileno())
                if (st.st_dev,st.st_ino)!=(file_id.st_dev,file_id.st_ino) or stream.read(4097)!=payload:raise RuntimeError('Readback mismatch.')
            result.update(write_read_rename_passed=True,sha256=hashlib.sha256(payload).hexdigest())
        finally:
            # Remove ONLY this probe's exact inode; never recursively clean media.
            if child is not None:
                try:
                    if file_id is not None:
                        st=os.stat(leaf,dir_fd=child,follow_symlinks=False)
                        if (st.st_dev,st.st_ino)!=(file_id.st_dev,file_id.st_ino):raise RuntimeError('Probe file replaced; left for review.')
                        os.unlink(leaf,dir_fd=child);os.fsync(child)
                    st=os.stat(name,dir_fd=fd,follow_symlinks=False)
                    if (st.st_dev,st.st_ino)!=(created.st_dev,created.st_ino):raise RuntimeError('Probe directory replaced; left for review.')
                    os.rmdir(name,dir_fd=fd);os.fsync(fd);result['cleanup_passed']=True
                finally:os.close(child)
        return result
    finally:os.close(fd)


if __name__=='__main__':
    if sys.argv[1] not in ('check','probe'):raise SystemExit('Unsupported permission operation.')
    if not any(line.split()[4]==ROOT and ' - nfs' in line for line in open('/proc/self/mountinfo')):raise SystemExit('Expected NFS child mount.')
    try:print(json.dumps(probe(ROOT,sys.argv[1],int(sys.argv[2]))))
    except (OSError,RuntimeError) as exc:
        print(json.dumps({'probe_failed':True,'error':str(exc)}));sys.exit(1)
