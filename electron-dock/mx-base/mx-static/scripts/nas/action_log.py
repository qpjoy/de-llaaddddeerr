"""Private local audit records for NAS mutations; never store command/env secrets."""
import fcntl
import json
import os
import stat
import time


def append(directory, action, part, outcome):
    fd=os.open('actions.jsonl',os.O_WRONLY|os.O_APPEND|os.O_CREAT|os.O_NOFOLLOW,0o600,dir_fd=directory)
    try:
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.geteuid() or st.st_mode & 0o077:raise RuntimeError('Unsafe NAS action log.')
        fcntl.flock(fd,fcntl.LOCK_EX)
        data=(json.dumps({'time_unix':time.time(),'uid':os.geteuid(),'pid':os.getpid(),
              'action':action,'task':part,'outcome':outcome},sort_keys=True)+'\n').encode()
        while data:
            count=os.write(fd,data)
            if count<=0:raise OSError('Short audit write.')
            data=data[count:]
        os.fsync(fd)
    finally:os.close(fd)
