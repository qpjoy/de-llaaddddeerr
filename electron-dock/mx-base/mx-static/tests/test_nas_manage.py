import contextlib
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts/nas'))
import manage as manager


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.profiles=manager.profiles();self.profile=self.profiles['part1']
        self.output=contextlib.redirect_stdout(io.StringIO());self.output.__enter__()
    def tearDown(self):self.output.__exit__(None,None,None)

    def rows(self):
        return {n:{'Id':n+'-id','State':{'Running':True,'Status':'running','Health':{'Status':'healthy'}}}
                for n in manager.prep.SERVICES}

    def fake_operation(self,rows):
        op=mock.Mock()
        op.state={'new_ids':{n:c['Id'] for n,c in rows.items()}}
        op.mounted_services.side_effect=lambda *a,**k:rows
        @contextlib.contextmanager
        def context(*a,**k):yield op,rows
        return op,context

    def test_nas_help_needs_no_node_or_static_service_env(self):
        # This fixture root has no package.json; NAS dispatch must happen before node.
        result=subprocess.run(['bash',str(ROOT/'scripts/manage.sh'),'nas','--help'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn(b'boot-check',result.stdout)

    def test_storage_declaration_matches_ten_child_mounts_and_gateway_readonly(self):
        storage=json.loads((ROOT/'deploy/nas/part1.storage.json').read_text())
        self.assertEqual(set(storage['services']),manager.prep.SERVICES)
        for name,value in storage['services'].items():
            mount=value['volumes'][0]
            self.assertEqual(mount['target'],manager.cutover.RAW)
            self.assertEqual(mount['read_only'],name=='gateway')
            self.assertTrue(mount['volume']['nocopy'])
        op=mock.Mock(overlay=storage)
        manager.storage_guard(op,self.profile)
        changed=copy.deepcopy(storage);changed['services']['web']['volumes'][0]['source']='wrong'
        with self.assertRaises(RuntimeError):manager.storage_guard(mock.Mock(overlay=changed),self.profile)

    def test_part2_pre_copy_supported_but_not_part1_cutover_or_reclaim(self):
        p=manager.parser()
        args=p.parse_args(['copy','part2','--unlimited'])
        command=manager.task_command('copy',self.profiles['part2'],args)
        self.assertEqual(command[-3:],['delta_59202_media_data','--copy','--unlimited'])
        for action in ('cutover','reclaim','recover','redeploy'):
            with self.assertRaises(RuntimeError):manager.task_command(action,self.profiles['part2'],args)

    def test_explicit_maintenance_and_acceptance_gates(self):
        p=manager.parser()
        for action,flag in (('cutover','--maintenance'),('redeploy','--maintenance'),('reclaim','--business-accepted')):
            with self.assertRaises(RuntimeError):manager.task_command(action,self.profile,p.parse_args([action,'part1']))
            self.assertTrue(manager.task_command(action,self.profile,p.parse_args([action,'part1',flag])))

    def test_recovery_does_not_touch_healthy_running_containers_or_host_nas(self):
        rows=self.rows();op,context=self.fake_operation(rows)
        with mock.patch.object(manager,'operation',context),mock.patch.object(manager.socket,'create_connection') as connect:
            manager.recover(self.profile)
        op.command.assert_not_called();op.open_media.assert_not_called();op.checkpoint.assert_not_called()
        connect.assert_not_called()

    def test_recovery_starts_only_stopped_registered_consumers_in_order(self):
        rows=self.rows()
        for c in rows.values():c['State']['Running']=False
        op,context=self.fake_operation(rows)
        starts=[]
        def command(args,**kwargs):
            self.assertEqual(args[:2],['docker','start'])
            name=args[2][:-3];starts.append(name);rows[name]['State']['Running']=True
        op.command.side_effect=command
        with mock.patch.object(manager,'operation',context),mock.patch.object(manager.socket,'create_connection'):
            manager.recover(self.profile)
        self.assertEqual(starts[:2],['web','chat-gateway'])
        self.assertEqual(starts[-2:],['gateway','beat'])
        self.assertEqual(set(starts),manager.prep.SERVICES)
        op.open_media.assert_not_called();op.stop.assert_not_called();op.checkpoint.assert_not_called()

    def test_running_unhealthy_container_is_never_force_restarted(self):
        rows=self.rows();rows['web']['State']['Health']['Status']='unhealthy'
        op,context=self.fake_operation(rows)
        with mock.patch.object(manager,'operation',context),self.assertRaises(RuntimeError):manager.recover(self.profile)
        op.command.assert_not_called()

    def test_paused_oom_or_docker_restart_in_progress_refuses_competing_start(self):
        for key in ('Paused','OOMKilled','Restarting'):
            rows=self.rows();rows['web']['State']['Running']=False;rows['web']['State'][key]=True
            op,context=self.fake_operation(rows)
            with mock.patch.object(manager,'operation',context),mock.patch.object(manager.socket,'create_connection'),self.assertRaises(RuntimeError):
                manager.recover(self.profile)
            op.command.assert_not_called()

    def test_nas_unreachable_never_starts_consumers(self):
        rows=self.rows();rows['web']['State']['Running']=False;op,context=self.fake_operation(rows)
        with mock.patch.object(manager,'operation',context),mock.patch.object(manager.socket,'create_connection',side_effect=OSError('down')),self.assertRaises(OSError):
            manager.recover(self.profile)
        op.command.assert_not_called()

    def test_boot_units_are_persistent_boot_only_and_never_run_copy_or_reclaim(self):
        files=manager.unit_files();service=files[manager.UNIT+'.service'];timer=files[manager.UNIT+'.timer']
        self.assertIn('\nType=simple\n',service);self.assertNotIn('\nType=oneshot\n',service)
        self.assertIn('RemainAfterExit=yes',service);self.assertIn('Restart=on-failure',service)
        self.assertIn('RestartSec=60s',service);self.assertIn('OnBootSec=60s',timer)
        self.assertNotIn('OnUnitInactiveSec',timer);self.assertNotIn('RequiresMountsFor',service)
        for forbidden in ('reclaim.py','precopy.py','rsync','ExecStop=','Requires=docker','mount -'):
            self.assertNotIn(forbidden,service)

    def test_locate_and_summary_do_not_expose_environment(self):
        row={'Id':'a'*64,'Config':{'Env':['PASSWORD=secret'],'Labels':{'com.docker.compose.project':'mx_data','com.docker.compose.service':'web'}},
             'State':{'Status':'running'},'Mounts':[]}
        data=json.dumps(manager.summary([row],self.profile))
        self.assertNotIn('PASSWORD',data);self.assertNotIn('secret',data)
        with mock.patch.object(manager,'emit') as emit:
            manager.locate('part1',self.profile)
            fields=emit.call_args.kwargs
        self.assertEqual(fields['runtime_override'],self.profile['report']+'/compose.nas.override.json')
        self.assertIn('deploy/nas',fields['git_registry'])

    def test_transient_copy_job_is_unique_and_preserves_ssd(self):
        args=manager.parser().parse_args(['copy','part2','--unlimited'])
        with mock.patch.object(manager,'run',return_value='') as run:
            manager.launch('copy',self.profiles['part2'],args)
            command=run.call_args.args[0]
        self.assertEqual(command[0],'systemd-run')
        self.assertIn('--property=ReadOnlyPaths=/data',command)
        self.assertIn('--property=RuntimeMaxSec=infinity',command)
        self.assertIn('--unlimited',command)
        self.assertFalse(any(x.startswith('--on-') for x in command))

    def test_already_switched_part1_copy_refused_before_job(self):
        with tempfile.TemporaryDirectory() as tmp:
            fd=os.open(tmp,manager.DIR_FLAGS)
            with mock.patch.object(manager.cutover,'open_report',return_value=fd),mock.patch.object(manager.cutover,'read_json',return_value={'nas_may_have_writes':True}),mock.patch.object(manager,'run') as run,self.assertRaises(RuntimeError):
                manager.launch('copy',self.profile,manager.parser().parse_args(['copy','part1']))
            run.assert_not_called()

    def test_reclaim_job_allows_ssd_write_and_requires_acceptance(self):
        args=manager.parser().parse_args(['reclaim','part1','--business-accepted'])
        with mock.patch.object(manager,'run',return_value='') as run:
            manager.launch('reclaim',self.profile,args)
        command=run.call_args.args[0]
        self.assertNotIn('--property=ReadOnlyPaths=/data',command)
        self.assertIn('--property=ReadOnlyPaths=/mnt/nas',command)
        self.assertEqual(command[-2:],['--business-accepted',self.profile['plan']])

    def test_redeploy_registers_created_ids_before_start_and_uses_exact_override(self):
        rows=self.rows();op,context=self.fake_operation(rows)
        op.path=self.profile['report']
        order=[]
        def stop(current):
            order.append('stop')
            for c in rows.values():c['State']['Running']=False
        op.stop.side_effect=stop
        def command(args,**kwargs):
            order.append('create')
            self.assertIn('--no-start',args);self.assertIn('--no-deps',args)
            self.assertIn(op.path+'/compose.nas.override.json',args)
            self.assertEqual(set(args[-10:]),manager.prep.SERVICES)
            for n,c in rows.items():c['Id']='new-'+n
        op.command.side_effect=command
        def checkpoint(phase,**values):
            order.append(phase)
            if phase=='nas_containers_created':
                self.assertEqual(op.state['new_ids'],{n:'new-'+n for n in manager.prep.SERVICES})
        op.checkpoint.side_effect=checkpoint
        op.start.side_effect=lambda *a,**k:order.append('start') or rows
        with mock.patch.object(manager,'operation',context):manager.redeploy(self.profile)
        self.assertEqual(order[:4],['stop','create','nas_containers_created','start'])
        op.config_guard.assert_called_once()
        op.http_probe.assert_called_once()
        op.seal.assert_called_once_with('cutover_running_on_nas')

    def test_redeploy_drain_failure_never_creates_or_starts(self):
        rows=self.rows();op,context=self.fake_operation(rows)
        op.stop.side_effect=RuntimeError('drain failed')
        with mock.patch.object(manager,'operation',context),self.assertRaises(RuntimeError):manager.redeploy(self.profile)
        op.command.assert_not_called();op.start.assert_not_called();op.checkpoint.assert_not_called()

    def test_auto_part2_policy_is_refused_without_modifying_systemd(self):
        with mock.patch.object(manager,'run') as run:
            for enabled in (True,False):
                with self.assertRaises(RuntimeError):manager.set_auto('part2',self.profiles['part2'],enabled)
            run.assert_not_called()

    def test_auto_installer_snapshots_only_code_policy_and_does_not_enable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);runtime=root/'runtime';config=root/'etc';units=root/'units'
            for p in (runtime,config,units):p.mkdir()
            def secure(path):
                p=units if path=='/etc/systemd/system' else Path(path)
                return os.open(str(p),manager.DIR_FLAGS)
            with mock.patch.object(manager,'RUNTIME',str(runtime)),mock.patch.object(manager,'AUTO_DIR',str(config)),mock.patch.object(manager,'secure_directory',side_effect=secure),mock.patch.object(manager,'run',return_value='') as run,mock.patch.object(manager,'auto_config',return_value={'schema':1,'enabled_parts':[]}):
                manager.install_auto()
            self.assertTrue((runtime/'current').is_symlink())
            self.assertEqual((runtime/'current/deploy/nas/profiles.json').read_bytes(),manager.CONFIG.read_bytes())
            self.assertEqual((runtime/'current/scripts/nas/projects/infra_probe.py').read_bytes(),(manager.ROOT/'scripts/nas/projects/infra_probe.py').read_bytes())
            installed=subprocess.run([sys.executable,'-B',str(runtime/'current/scripts/nas/manage.py'),'project','list'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            self.assertEqual(installed.returncode,0,installed.stderr)
            self.assertEqual(set(json.loads(installed.stdout)['projects']),{'infra','delta'})
            self.assertFalse(list((runtime/'current').rglob('.env')))
            self.assertEqual(json.loads((config/'auto.json').read_text())['enabled_parts'],[])
            self.assertEqual(run.call_args_list[0].args[0][:3],['systemd-analyze','--man=no','verify'])
            self.assertEqual(run.call_args_list[1:],[mock.call(['systemctl','daemon-reload'])])
            self.assertEqual(stat_mode(config/'auto.json'),0o600)


def stat_mode(path):return path.stat().st_mode & 0o777


if __name__=='__main__':unittest.main()
