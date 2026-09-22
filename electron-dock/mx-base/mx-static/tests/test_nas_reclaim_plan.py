import contextlib
import copy
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts/nas'))
import reclaim_plan as plan


class ReclaimPlanTests(unittest.TestCase):
    def test_completed_cutover_is_required_but_never_approves_deletion(self):
        state={'schema':1,'volume':plan.prep.VOLUME,'report_directory':'report','phase':'running_on_nas',
               'final_sync_passed':True,'nas_may_have_writes':True,'reclaim_ready':False,
               'new_ids':{n:n for n in plan.prep.SERVICES}}
        plan.require_completed(state,'report')
        for key,value in [('phase','final_sync_passed'),('nas_may_have_writes',False),('final_sync_passed',False),
                           ('reclaim_ready',True),('volume','delta_59202_media_data'),('new_ids',{})]:
            wrong=dict(state);wrong[key]=value
            with self.assertRaises(RuntimeError):plan.require_completed(wrong,'report')

    def test_unknown_named_volume_and_bind_ancestors_are_reported(self):
        def container(path=None,volume=None,ident='foreign'):
            return {'Id':ident,'Name':'fixture','Mounts':[{'Type':'bind' if path else 'volume',
                'Source':path or '/volume','Name':volume,'Destination':'/test'}]}
        source='/data/docker/volumes/'+plan.prep.VOLUME+'/_data/data_hub_raw_media'
        for path in ('/', '/data', source, source+'/video'):
            self.assertTrue(plan.extra_source_consumers([container(path)],set()))
        self.assertTrue(plan.extra_source_consumers([container(volume=plan.prep.VOLUME)],set()))
        self.assertFalse(plan.extra_source_consumers([container('/data/models')],set()))
        self.assertFalse(plan.extra_source_consumers([container(source+'-other')],set()))
        self.assertFalse(plan.extra_source_consumers([container(source,ident='known')],{'known'}))

    def test_health_requires_http_health_and_running_workers(self):
        rows={name:{'State':{'Running':True,'Health':{'Status':'healthy'}}} for name in plan.prep.SERVICES}
        plan.health_guard(rows)
        for name,key,value in [('web','Running',False),('worker','Paused',True),('beat','Restarting',True),
                               ('gateway','Health',{'Status':'unhealthy'})]:
            changed=copy.deepcopy(rows);changed[name]['State'][key]=value
            with self.assertRaises(RuntimeError):plan.health_guard(changed)

    def test_real_manifest_keeps_all_media_and_other_volume_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'media/data_hub_raw_media';source.mkdir(parents=True)
            (source/'video').mkdir();(source/'video/old\nfile.bin').write_bytes(b'original')
            (source/'video/raw-media-x.tmp').write_bytes(b'keep temp')
            other=root/'media/agent_runs';other.mkdir();(other/'keep').write_bytes(b'other data')
            out=root/'report';out.mkdir()
            fds=[os.open(str(p),plan.DIR_FLAGS) for p in (source,out)]
            try:
                before={str(p.relative_to(root/'media')):p.read_bytes() for p in (root/'media').rglob('*') if p.is_file()}
                result=plan.write_plan(*fds,allocated_bytes=16384)
                after={str(p.relative_to(root/'media')):p.read_bytes() for p in (root/'media').rglob('*') if p.is_file()}
                self.assertEqual(before,after)
                self.assertEqual(result['regular_files'],2);self.assertEqual(result['logical_bytes'],17)
                self.assertEqual(result['du_allocated_bytes'],16384)
                self.assertFalse(result['deletion_supported']);self.assertFalse(result['reclaim_ready'])
                self.assertTrue(result['preserve_source_root'])
                entries=[json.loads(line) for line in (out/'files.jsonl').read_text().splitlines()]
                self.assertEqual(len(entries),4)
                self.assertIn('video/old\nfile.bin',[r['path'] for r in entries])
                self.assertEqual(stat.S_IMODE((out/'files.jsonl').stat().st_mode),0o600)
            finally:
                for fd in fds:os.close(fd)

    def test_symlink_inventory_and_delete_cli_are_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'source';source.mkdir();out=root/'out';out.mkdir()
            outside=root/'keep';outside.write_bytes(b'keep');(source/'link').symlink_to(outside)
            fds=[os.open(str(p),plan.DIR_FLAGS) for p in (source,out)]
            try:
                with contextlib.redirect_stdout(io.StringIO()),self.assertRaises(RuntimeError):plan.write_plan(*fds,allocated_bytes=0)
                self.assertEqual(outside.read_bytes(),b'keep');self.assertTrue((source/'link').is_symlink())
            finally:
                for fd in fds:os.close(fd)
        for args in (['--delete'],['report','--delete'],['--apply','report']):
            result=subprocess.run(['bash',str(ROOT/'scripts/nas-reclaim-plan.sh')]+args,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            self.assertEqual(result.returncode,2)


if __name__=='__main__':unittest.main()
