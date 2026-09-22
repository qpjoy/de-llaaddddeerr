import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts/nas'))
import reclaim
import reclaim_plan


class ReclaimTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.source = self.root/'source'; self.source.mkdir()
        (self.source/'video').mkdir()
        (self.source/'video/a\n.bin').write_bytes(b'video1')
        (self.source/'video/b.tmp').write_bytes(b'keep until copied')
        self.other = self.root/'agent_runs'; self.other.mkdir(); (self.other/'keep').write_bytes(b'other')
        self.nas = self.root/'nas'; shutil.copytree(str(self.source), str(self.nas), copy_function=shutil.copy2)
        self.out = self.root/'report'; self.out.mkdir()
        self.fds = [os.open(str(p), reclaim.DIR_FLAGS) for p in (self.source, self.nas, self.out)]
        self.src, self.dst, self.output = self.fds
        self.plan = reclaim_plan.write_plan(self.src, self.output, 16384)
        self.plan['source_identity'] = reclaim.precopy.source_identity(self.src)
        self.tree = reclaim.read_manifest(self.output, self.plan)
        self.paths = reclaim.remaining_files(self.src, self.tree, set())
        self.journal = reclaim.private_file(self.output, 'journal', os.O_RDWR|os.O_CREAT|os.O_APPEND)
        self.fds.append(self.journal)
        self.stdout = contextlib.redirect_stdout(io.StringIO()); self.stdout.__enter__()

    def tearDown(self):
        self.stdout.__exit__(None,None,None)
        for fd in self.fds: os.close(fd)
        self.tmp.cleanup()

    def test_reclaims_exact_files_keeps_directories_nas_and_other_media_and_can_repeat(self):
        root_id = reclaim.precopy.source_identity(self.src)
        reclaim.check_nas_files(self.dst,self.tree,self.paths)
        calls=[]
        n, size = reclaim.delete_files(self.src,self.dst,self.tree,self.paths,self.journal,lambda:calls.append(True))
        self.assertEqual(n,2); self.assertEqual(size,23); self.assertTrue(calls)
        self.assertEqual(reclaim.precopy.source_identity(self.src),root_id)
        self.assertTrue((self.source/'video').is_dir())
        self.assertEqual((self.nas/'video/a\n.bin').read_bytes(),b'video1')
        self.assertEqual((self.nas/'video/b.tmp').read_bytes(),b'keep until copied')
        self.assertEqual((self.other/'keep').read_bytes(),b'other')
        permitted=reclaim.read_intents(self.journal,self.tree)
        self.assertEqual(reclaim.remaining_files(self.src,self.tree,permitted),[])
        self.assertEqual(reclaim.delete_files(self.src,self.dst,self.tree,[],self.journal,lambda:None),(0,0))

    def test_interruption_journals_before_delete_and_resumes_only_known_missing_files(self):
        unlink=os.unlink; calls=[]
        def interrupt(name,**kwargs):
            self.assertEqual(reclaim.read_intents(self.journal,self.tree),set(self.paths))
            if calls: raise OSError('simulated interruption')
            calls.append(name); return unlink(name,**kwargs)
        with mock.patch.object(reclaim.os,'unlink',side_effect=interrupt),self.assertRaises(OSError):
            reclaim.delete_files(self.src,self.dst,self.tree,self.paths,self.journal,lambda:None)
        permitted=reclaim.read_intents(self.journal,self.tree)
        pending=reclaim.remaining_files(self.src,self.tree,permitted)
        self.assertEqual(len(pending),1)
        reclaim.delete_files(self.src,self.dst,self.tree,pending,self.journal,lambda:None)
        self.assertEqual(reclaim.remaining_files(self.src,self.tree,permitted),[])

    def test_unjournaled_missing_file_refused(self):
        (self.source/'video/b.tmp').unlink()
        with self.assertRaises(RuntimeError):reclaim.remaining_files(self.src,self.tree,set())

    def test_new_source_file_refused_and_preserved(self):
        (self.source/'new').write_bytes(b'new data')
        with self.assertRaises(RuntimeError):reclaim.remaining_files(self.src,self.tree,set())
        self.assertEqual((self.source/'new').read_bytes(),b'new data')

    def test_changed_source_file_refused_before_unlink(self):
        (self.source/'video/a\n.bin').write_bytes(b'edited')
        with self.assertRaises(RuntimeError):reclaim.delete_files(self.src,self.dst,self.tree,self.paths,self.journal,lambda:None)
        self.assertEqual((self.source/'video/a\n.bin').read_bytes(),b'edited')
        self.assertTrue((self.source/'video/b.tmp').is_file())

    def test_changed_nas_file_preserves_ssd(self):
        (self.nas/'video/a\n.bin').write_bytes(b'changed NAS copy')
        with self.assertRaises(RuntimeError):reclaim.check_nas_files(self.dst,self.tree,self.paths)
        with self.assertRaises(RuntimeError):reclaim.delete_files(self.src,self.dst,self.tree,self.paths,self.journal,lambda:None)
        self.assertEqual((self.source/'video/a\n.bin').read_bytes(),b'video1')

    def test_nas_extras_are_not_scanned_or_removed(self):
        (self.nas/'new-live-file').write_bytes(b'new NAS data')
        (self.nas/'new-link').symlink_to('/nonexistent')
        reclaim.check_nas_files(self.dst,self.tree,self.paths)
        reclaim.delete_files(self.src,self.dst,self.tree,self.paths,self.journal,lambda:None)
        self.assertEqual((self.nas/'new-live-file').read_bytes(),b'new NAS data')
        self.assertTrue((self.nas/'new-link').is_symlink())

    def test_symlink_nas_parent_is_refused(self):
        (self.nas/'video').rename(self.nas/'old-video')
        (self.nas/'video').symlink_to(self.nas/'old-video',target_is_directory=True)
        with self.assertRaises(OSError):reclaim.check_nas_files(self.dst,self.tree,self.paths)
        self.assertTrue((self.source/'video/a\n.bin').is_file())

    def test_directory_replacement_refused(self):
        (self.source/'video').rename(self.source/'old-video')
        shutil.copytree(str(self.source/'old-video'),str(self.source/'video'))
        with self.assertRaises(RuntimeError):reclaim.delete_files(self.src,self.dst,self.tree,self.paths,self.journal,lambda:None)
        self.assertTrue((self.source/'old-video/a\n.bin').is_file())

    def test_manifest_checksum_tampering_refused(self):
        p=dict(self.plan,manifest_sha256='0'*64)
        with self.assertRaises(RuntimeError):reclaim.read_manifest(self.output,p)

    def test_manifest_unsafe_and_duplicate_paths_refused(self):
        original=(self.out/'files.jsonl').read_bytes()
        row={'kind':'entry','path':'../outside','metadata':self.tree[self.paths[0]]}
        for data in (json.dumps(row).encode()+b'\n',original+original.splitlines(keepends=True)[0]):
            (self.out/'files.jsonl').write_bytes(data)
            with self.assertRaises(RuntimeError):reclaim.read_manifest(self.output,self.plan)

    def test_incomplete_or_outside_journal_refused(self):
        for data in (b'{"kind":"unlink_intent"}',b'{"kind":"unlink_intent","paths":["../other"]}\n'):
            os.ftruncate(self.journal,0); os.write(self.journal,data)
            with self.assertRaises((RuntimeError,ValueError)):reclaim.read_intents(self.journal,self.tree)

    def test_batch_guard_failure_precedes_any_deletion(self):
        def refuse():raise RuntimeError('deployment changed')
        with self.assertRaises(RuntimeError):reclaim.delete_files(self.src,self.dst,self.tree,self.paths,self.journal,refuse)
        self.assertEqual(reclaim.read_intents(self.journal,self.tree),set())
        self.assertTrue((self.source/'video/a\n.bin').exists())

    def test_cli_requires_explicit_business_acceptance(self):
        for args in (['report'],['--delete','report'],['--business-accepted'],['--business-accepted','report','--force']):
            result=subprocess.run(['bash',str(ROOT/'scripts/nas-reclaim.sh')]+args,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            self.assertEqual(result.returncode,2)


if __name__=='__main__':unittest.main()
