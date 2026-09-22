import contextlib
import copy
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts/nas'))
import catalog
import host
import manage
import action_log
from projects import infra,infra_probe


class PlatformTests(unittest.TestCase):
    def test_nested_commands_keep_task_and_acceptance_boundaries(self):
        examples=[(['infra','status'],['status','part1']),(['project','infra','recovery'],['recover','part1']),
          (['infra','task','part1','cleanup','--business-accepted'],['reclaim','part1','--business-accepted']),
          (['delta','task','part2','copy','--unlimited'],['copy','part2','--unlimited']),
          (['recovery','install'],['auto-install']),(['recovery','enable','infra'],['auto-enable','part1']),
          (['infra','permissions','check'],['permissions-check','part1']),
          (['infra','permissions','probe','--write-test'],['permissions-probe','part1','--write-test']),
          (['infra','deployment','audit'],['deployment-audit','part1'])]
        for args,result in examples:self.assertEqual(catalog.route(args,manage.CONFIG),result)

    def test_cross_project_and_unreviewed_actions_refused(self):
        for args in (['infra','task','part2','cleanup'],['delta','task','part2','cleanup','--business-accepted'],
                     ['delta','recovery'],['recovery','enable','delta'],['host','reboot'],['host','umount'],
                     ['infra','permissions','probe'],['infra','permissions','probe','--write-test','--force']):
            with self.assertRaises(RuntimeError):catalog.route(args,manage.CONFIG)

    def test_original_commands_preserved(self):
        for args in (['status','part1'],['copy','part2','--unlimited'],['reclaim','part1','--business-accepted']):
            self.assertEqual(catalog.route(args,manage.CONFIG),args)

    def test_catalog_paths_reject_traversal_absolute_and_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp).resolve();(base/'real.json').write_text('{}');(base/'link.json').symlink_to(base/'real.json')
            for name in ('../real.json','/etc/passwd','link.json','x/../real.json'):
                with self.assertRaises(RuntimeError):catalog.read_relative(base,name)

    def test_catalog_refuses_duplicate_task_and_unreviewed_write_capability(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp).resolve()/'nas';shutil.copytree(str(ROOT/'deploy/nas'),str(base))
            p=base/'projects/delta.json';original=json.loads(p.read_text())
            for changed in (dict(original,tasks=['part1']),dict(original,adapter='manual-review',capabilities=['reclaim'])):
                p.write_text(json.dumps(changed))
                with self.assertRaises(RuntimeError):catalog.load(base/'profiles.json')

    def test_catalog_lists_offline_without_node_or_docker(self):
        r=subprocess.run(['bash',str(ROOT/'scripts/manage.sh'),'nas','project','list','--json'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        self.assertEqual(r.returncode,0,r.stderr)
        result=json.loads(r.stdout);self.assertEqual(set(result['projects']),{'infra','delta'})

    def test_installation_includes_nested_policy_and_adapter_files(self):
        names={str(p.relative_to(manage.CONFIG.parent)) for p in catalog.installed_files(manage.CONFIG)}
        self.assertIn('hosts/mx-internal-server.json',names);self.assertIn('projects/infra.json',names)
        self.assertNotIn('.env',names)

    def test_mount_table_distinguishes_host_nfs_and_container_volumes_without_stat(self):
        policy=catalog.load(manage.CONFIG)[1]
        text='50 30 0:656 / /mnt/nas rw - nfs nas-storage:/volume1/data1 rw,hard\n51 30 0:700 / /data/docker/volumes/v/_data rw - nfs 192.168.1.3:/other rw,hard\n'
        with mock.patch.object(host.os if hasattr(host,'os') else os,'stat',side_effect=AssertionError('must not stat')):
            rows=host.mounts(policy,text)
        self.assertEqual([r['expected_host_mount'] for r in rows],[True,False])
        self.assertFalse(host.mounts(policy,text.replace('nas-storage:/volume1/data1','wrong:/data'))[0]['expected_host_mount'])

    def test_process_snapshot_is_bounded_and_does_not_claim_all_d_state_is_nfs(self):
        text='1 0 S systemd ep_poll\n2 1 D worker rpc_wait_bit_killable\n3 1 S rpc.statd poll_schedule_timeout\n'
        result=host.processes(text)
        self.assertEqual(result['all_d_state_count'],1)
        self.assertEqual(len(result['sample']),2)
        self.assertNotIn('command',result['sample'][0])
        result=host.processes('\n'.join('{} 1 D worker wait'.format(i) for i in range(1,150)))
        self.assertEqual(len(result['sample']),80);self.assertEqual(result['all_d_state_count'],149)

    def test_application_readonly_check_never_creates_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'business').write_bytes(b'keep')
            value=infra_probe.probe(tmp,'check',root.stat().st_ino)
            self.assertFalse(value['write_test']);self.assertEqual(sorted(p.name for p in root.iterdir()),['business'])

    def test_application_write_probe_preserves_business_and_permissions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);business=root/'business';business.write_bytes(b'keep');business.chmod(0o640)
            before=business.stat();rootmode=root.stat().st_mode
            result=infra_probe.probe(tmp,'probe',root.stat().st_ino)
            self.assertTrue(result['write_read_rename_passed']);self.assertTrue(result['cleanup_passed'])
            self.assertEqual(sorted(p.name for p in root.iterdir()),['business'])
            self.assertEqual(business.read_bytes(),b'keep');self.assertEqual(business.stat().st_mode,before.st_mode)
            self.assertEqual(root.stat().st_mode,rootmode)

    def test_application_probe_rejects_wrong_directory_identity_without_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(RuntimeError):infra_probe.probe(tmp,'probe',os.stat(tmp).st_ino+1)
            self.assertEqual(os.listdir(tmp),[])

    def test_failed_probe_cleans_only_its_own_file_and_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'business').write_bytes(b'keep')
            with mock.patch.object(infra_probe.os,'rename',side_effect=OSError('rename refused')),self.assertRaises(OSError):
                infra_probe.probe(tmp,'probe',root.stat().st_ino)
            self.assertEqual(os.listdir(tmp),['business'])

    def test_business_permission_check_never_overrides_container_user(self):
        rows={n:{'Id':n} for n in manage.prep.SERVICES};op=mock.Mock()
        op.saved={'precopy_state':{'target_inode':12}};op.command.return_value='{"uid":1001,"gid":1002,"effective_read":true,"effective_write":true,"effective_search":true}'
        @contextlib.contextmanager
        def context(*a,**k):yield op,rows
        with mock.patch.object(manage,'operation',context),contextlib.redirect_stdout(io.StringIO()):infra.permissions(manage,manage.profiles()['part1'],False)
        self.assertEqual(op.command.call_count,9)
        for call in op.command.call_args_list:
            args=call.args[0];self.assertEqual(args[:2],['docker','exec']);self.assertNotIn('--user',args)
            self.assertNotIn('gateway',args[:4]);self.assertEqual(args[-2: ],['check','12'])
        op.http_probe.assert_called_once_with(rows)

    def test_deployment_audit_finds_risks_without_exposing_literals(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'scripts').mkdir()
            for name in ('deploy_public_ghcr.sh','run_web.sh','run_worker.sh'):
                (root/'scripts'/name).write_text('PASSWORD=secret-value\nfind /app/media -type f -exec chmod 644 {} +\npython manage.py migrate\npython manage.py bootstrap_admin\n')
            with mock.patch.object(manage.prep,'DEPLOY',str(root.resolve())),mock.patch.object(infra,'emit') as emit:
                infra.deployment_audit(manage,manage.profiles()['part1'])
            data=json.dumps(emit.call_args.kwargs)
            self.assertIn('recursive_media_chmod',data);self.assertIn('bootstrap_admin',data)
            self.assertNotIn('secret-value',data);self.assertNotIn('PASSWORD',data)

    def test_infra_audit_refuses_another_project_before_reading_files(self):
        with mock.patch.object(infra.os,'open') as opened:
            with self.assertRaises(RuntimeError):infra.deployment_audit(manage,manage.profiles()['part2'])
            opened.assert_not_called()

    def test_private_action_log_records_outcomes_not_command_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            fd=os.open(tmp,manage.DIR_FLAGS)
            try:
                action_log.append(fd,'reclaim','part1','requested');action_log.append(fd,'reclaim','part1','command_completed')
            finally:os.close(fd)
            p=Path(tmp)/'actions.jsonl';rows=[json.loads(l) for l in p.read_text().splitlines()]
            self.assertEqual([r['outcome'] for r in rows],['requested','command_completed'])
            self.assertEqual(p.stat().st_mode & 0o777,0o600)
            self.assertNotIn('args',rows[0]);self.assertNotIn('env',rows[0])

    def test_action_log_refuses_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'keep').write_text('original');(root/'actions.jsonl').symlink_to(root/'keep')
            fd=os.open(tmp,manage.DIR_FLAGS)
            try:
                with self.assertRaises(OSError):action_log.append(fd,'reclaim','part1','requested')
            finally:os.close(fd)
            self.assertEqual((root/'keep').read_text(),'original')

    def test_permission_probe_requires_explicit_write_flag_before_launch(self):
        p=manage.profiles()['part1']
        with self.assertRaises(RuntimeError):manage.task_command('permissions-probe',p,manage.parser().parse_args(['permissions-probe','part1']))
        args=manage.parser().parse_args(['permissions-probe','part1','--write-test'])
        self.assertEqual(manage.task_command('permissions-probe',p,args)[-3:],['_execute-permissions','part1','--write-test'])


if __name__=='__main__':unittest.main()
