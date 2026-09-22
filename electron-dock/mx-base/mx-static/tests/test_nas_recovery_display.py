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
import catalog
import display
import host
import manage
import recovery


class DisplayTests(unittest.TestCase):
    def command(self,*args):
        return subprocess.run(['bash',str(ROOT/'scripts/manage.sh'),'nas']+list(args),stdout=subprocess.PIPE,stderr=subprocess.PIPE,universal_newlines=True)

    def test_default_is_human_and_json_remains_parseable(self):
        human=self.command('project','list');self.assertEqual(human.returncode,0,human.stderr)
        self.assertIn('NAS 项目登记',human.stdout);self.assertIn('待迁移',human.stdout);self.assertNotIn('"event"',human.stdout)
        raw=self.command('--json','project','list');self.assertEqual(raw.returncode,0,raw.stderr)
        self.assertEqual(json.loads(raw.stdout)['event'],'nas_projects')
        pretty=self.command('project','list','--pretty');self.assertEqual(pretty.returncode,0,pretty.stderr)
        self.assertEqual(json.loads(raw.stdout),json.loads(pretty.stdout));self.assertIn('\n  "event"',pretty.stdout)

    def test_conflicting_flags_and_failure_exit_are_not_hidden(self):
        result=self.command('--json','project','list','--pretty');self.assertEqual(result.returncode,2)
        result=self.command('delta','cleanup');self.assertEqual(result.returncode,1)
        self.assertIn('操作失败',result.stdout)

    def test_host_units_distinguish_uninstalled_from_inactive(self):
        text='Id=ready.service\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n\nId=absent.service\nLoadState=not-found\nActiveState=inactive\nSubState=dead\n'
        output=display.units(text)
        self.assertIn('未安装',output);self.assertIn('active/running',output);self.assertIn('enabled',output)

    def test_human_warnings_and_unknown_fields_are_preserved(self):
        result=display.format_line(json.dumps({'event':'new_future_event','reclaim_ready':False,'error':'unexpected'}))
        self.assertIn('false',result);self.assertIn('unexpected',result)
        result=display.render({'event':'nas_migration_state','part':'part1','phase':'running_on_nas','business_acceptance_pending':True,'ssd_reclaim':None})
        self.assertIn('业务验收待完成：是',result);self.assertIn('尚无完成记录',result)
        self.assertNotIn('\x1b',display.format_line('{"event":"future","name":"\\u001b[31mBAD"}'))

    def test_cli_filter_returns_original_failure_status(self):
        output=io.StringIO()
        child=mock.Mock(stdout=io.StringIO('{"event":"future","ok":false}\n'),wait=mock.Mock(return_value=7))
        with mock.patch.object(sys,'argv',['display.py','project','list']),mock.patch.object(display.subprocess,'Popen',return_value=child),contextlib.redirect_stdout(output):
            self.assertEqual(display.main(),7)
        self.assertIn('false',output.getvalue())

    def test_unrelated_autofs_and_frpc_are_not_nfs_processes(self):
        policy=catalog.load(manage.CONFIG)[1]
        text='1 2 0:1 / /proc/sys/fs/binfmt_misc rw - autofs systemd-1 rw\n2 3 0:2 / /mnt/nas rw - nfs nas-storage:/volume1/data1 rw,hard,vers=3\n'
        rows=host.mounts(policy,text);self.assertEqual(len(rows),1);self.assertIn('hard',rows[0]['options'])
        rows=host.processes('1 0 S frpc wait\n2 0 I kblockd wait\n3 0 S rpc.statd wait\n4 0 D worker wait\n')
        self.assertEqual([r['comm'] for r in rows['sample']],['rpc.statd','worker'])
        self.assertEqual(rows['all_d_state_count'],1)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.index,self.host,self.projects=copy.deepcopy(catalog.load(manage.CONFIG))
        self.policy=recovery.normalize({'schema':1,'enabled_parts':[]},self.index['parts'])
        self.output=contextlib.redirect_stdout(io.StringIO());self.output.__enter__()
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.saved={}
        for task,p in self.index['parts'].items():
            path=Path(self.directory.name)/task;path.mkdir()
            if p.get('report'):p['report']=str(path)
            self.saved[task]={'schema':1,'volume':p['volume'],'report_directory':p['report'],'phase':'running_on_nas','final_sync_passed':True,'nas_may_have_writes':True}
        self.profile=self.index['parts']['part1']
        self.write_report('part1')
        self.catalog_patch=mock.patch.object(recovery.catalog,'load',return_value=(self.index,self.host,self.projects));self.catalog_patch.start();self.addCleanup(self.catalog_patch.stop)
        self.policy_patch=mock.patch.object(manage,'auto_config',side_effect=lambda:copy.deepcopy(self.policy));self.policy_patch.start();self.addCleanup(self.policy_patch.stop)
        self.inspect=mock.patch.object(manage.precopy,'inspect_containers',return_value=[]);self.inspect_mock=self.inspect.start();self.addCleanup(self.inspect.stop)
        self.open_patch=mock.patch.object(manage.cutover,'open_report',side_effect=lambda p:os.open(p,manage.DIR_FLAGS));self.open_patch.start();self.addCleanup(self.open_patch.stop)
        self.read_patch=mock.patch.object(manage.cutover,'read_json',side_effect=self.read_json);self.read_patch.start();self.addCleanup(self.read_patch.stop)
        self.operation_calls=[]
        @contextlib.contextmanager
        def operation(profile,require_running=False):
            self.operation_calls.append((profile['volume'],require_running))
            yield mock.Mock(),{'web':{'State':{'Running':True,'Health':{'Status':'healthy'}}}}
        self.op_patch=mock.patch.object(manage,'operation',side_effect=operation);self.op=self.op_patch.start();self.addCleanup(self.op_patch.stop)
    def tearDown(self):self.output.__exit__(None,None,None)
    def write_report(self,task):
        p=Path(self.index['parts'][task]['report']);(p/'execution.json').write_text(json.dumps(self.saved[task]))
    def read_json(self,fd,name):
        f=os.open(name,os.O_RDONLY,dir_fd=fd)
        with os.fdopen(f) as stream:return json.load(stream)

    def test_global_routes_and_legacy_routes(self):
        examples=[(['recovery','check'],['recovery-check-all']),(['recovery','status'],['recovery-check-all']),
                  (['recovery','enable','--migrated'],['recovery-enable-migrated']),(['recovery','disable'],['recovery-disable-all']),
                  (['recovery','enable','infra'],['auto-enable','part1'])]
        for args,want in examples:self.assertEqual(catalog.route(args,manage.CONFIG),want)

    def test_legacy_settings_default_to_explicit_and_unknown_tasks_fail(self):
        self.assertEqual(self.policy['mode'],'explicit');self.assertFalse(self.policy['suspended'])
        for value in ({'schema':1,'enabled_parts':['unknown']},{'schema':1,'enabled_parts':['part1'],'disabled_parts':['part1']},
                      {'schema':1,'enabled_parts':[],'suspended':'false'}):
            with self.assertRaises(RuntimeError):recovery.normalize(value,self.index['parts'])

    def test_checks_all_projects_and_reports_omission_without_start_or_nas_access(self):
        with mock.patch.object(manage,'recover') as recover,mock.patch.object(manage,'run') as run:
            policy,rows=recovery.inventory(manage)
        self.assertEqual({r['task']:r['state'] for r in rows},{'part1':'eligible','part2':'not_migrated'})
        self.assertEqual(next(r for r in rows if r['task']=='part1')['coverage'],'遗漏：未启用')
        self.assertEqual(len(self.operation_calls),1);recover.assert_not_called();run.assert_not_called()

    def test_global_policy_selects_success_but_excludes_just_copied_project(self):
        self.policy['mode']='migrated'
        with mock.patch.object(manage,'recover') as recover:recovery.run_all(manage)
        recover.assert_called_once_with(self.profile)

    def test_unreviewed_project_with_actual_nas_mount_is_flagged_not_started(self):
        self.policy['mode']='migrated'
        self.inspect_mock.return_value=[{'Config':{'Labels':{'com.docker.compose.project':'delta_59202'}},'Mounts':[{'Name':'delta_59202_raw_media_nfs_v1'}]}]
        with mock.patch.object(manage,'recover') as recover,self.assertRaises(RuntimeError):recovery.run_all(manage)
        recover.assert_called_once_with(self.profile)

    def test_completed_report_is_insufficient_without_reviewed_adapter(self):
        p=self.index['parts']['part2'];p['report']=str(Path(self.directory.name)/'part2')
        self.saved['part2']['report_directory']=p['report'];self.write_report('part2')
        policy,rows=recovery.inventory(manage)
        self.assertEqual(next(r for r in rows if r['task']=='part2')['state'],'blocked')
        self.assertEqual(len(self.operation_calls),1)

    def test_nas_write_boundary_and_exact_report_identity_are_required(self):
        for field,value in [('nas_may_have_writes',False),('phase','nas_containers_created'),('volume','wrong'),('final_sync_passed',False)]:
            original=copy.deepcopy(self.saved['part1']);self.saved['part1'][field]=value;self.write_report('part1')
            policy,rows=recovery.inventory(manage)
            self.assertEqual(next(r for r in rows if r['task']=='part1')['state'],'blocked')
            self.saved['part1']=original
        self.assertEqual(self.operation_calls,[])

    def test_explicit_existing_selection_without_record_is_an_error_not_silent_skip(self):
        self.policy['enabled_parts']=['part2']
        with mock.patch.object(manage,'recover') as recover,self.assertRaises(RuntimeError):recovery.run_all(manage)
        recover.assert_not_called()

    def test_global_and_project_pauses_prevent_start(self):
        self.policy['mode']='migrated'
        for change in ({'suspended':True},{'suspended':False,'disabled_parts':['part1']}):
            self.policy.update(change)
            with mock.patch.object(manage,'recover') as recover:recovery.run_all(manage)
            recover.assert_not_called()

    def test_configuration_drift_blocks_batch_enable_before_any_write(self):
        self.op.side_effect=RuntimeError('configuration drift')
        with mock.patch.object(recovery,'installed_current',return_value=True),mock.patch.object(manage,'systemd_summary',return_value={'units':''}),mock.patch.object(recovery,'save') as save,mock.patch.object(manage,'run') as run,self.assertRaises(RuntimeError):
            recovery.enable_migrated(manage)
        save.assert_not_called();run.assert_not_called()

    def test_enable_global_requires_install_and_preserves_pauses(self):
        with mock.patch.object(recovery,'installed_current',return_value=False),mock.patch.object(recovery,'save') as save,self.assertRaises(RuntimeError):recovery.enable_migrated(manage)
        save.assert_not_called()
        self.policy['disabled_parts']=['part1'];self.policy['suspended']=True
        with mock.patch.object(recovery,'installed_current',return_value=True),mock.patch.object(manage,'systemd_summary',return_value={'units':''}),mock.patch.object(recovery,'save') as save,mock.patch.object(manage,'run') as run:
            recovery.enable_migrated(manage)
        saved=save.call_args.args[1];self.assertEqual(saved['mode'],'migrated');self.assertEqual(saved['disabled_parts'],['part1']);self.assertFalse(saved['suspended'])
        self.assertEqual(run.call_args.args[0],['systemctl','enable','--now',manage.UNIT+'.timer'])
        self.assertTrue(all(flag is True for volume,flag in self.operation_calls))

    def test_boot_rechecks_inventory_and_continues_after_one_project_fails(self):
        policy=dict(self.policy,mode='migrated')
        rows=[{'project':'alpha','task':'part1','state':'eligible'},{'project':'beta','task':'part2','state':'eligible'}]
        with mock.patch.object(recovery,'inventory',return_value=(policy,rows)) as inventory,mock.patch.object(manage,'recover',side_effect=[RuntimeError('down'),None]) as recover,self.assertRaises(RuntimeError):recovery.run_all(manage)
        inventory.assert_called_once_with(manage);self.assertEqual(recover.call_count,2)

    def test_disable_all_stops_helper_only_and_keeps_project_choices(self):
        self.policy.update(mode='migrated',enabled_parts=['part1'])
        with mock.patch.object(recovery,'save') as save,mock.patch.object(manage,'run') as run:recovery.disable_all(manage)
        self.assertTrue(save.call_args.args[1]['suspended']);self.assertEqual(save.call_args.args[1]['enabled_parts'],['part1'])
        self.assertEqual(run.call_args_list,[mock.call(['systemctl','disable','--now',manage.UNIT+'.timer']),mock.call(['systemctl','stop',manage.UNIT+'.service'])])

    def test_future_reviewed_completion_is_discovered_without_per_project_enable(self):
        self.policy['mode']='migrated'
        with mock.patch.object(manage,'recover') as recover:recovery.run_all(manage)
        self.assertEqual(recover.call_count,1)
        p=self.index['parts']['part2'];p['report']=str(Path(self.directory.name)/'part2')
        self.saved['part2']['report_directory']=p['report'];self.write_report('part2')
        # Simulates the future adapter being explicitly implemented/reviewed.
        with mock.patch.object(recovery,'reviewed',return_value=True),mock.patch.object(manage,'recover') as recover:
            recovery.run_all(manage)
        self.assertEqual(recover.call_count,2);self.assertEqual(self.policy['enabled_parts'],[])

    def test_individual_pause_keeps_global_mode_and_other_projects_timer(self):
        self.policy['mode']='migrated'
        with mock.patch.object(manage,'secure_directory',side_effect=lambda p:os.open(self.directory.name,manage.DIR_FLAGS)),mock.patch.object(manage.cutover,'atomic_json') as save,mock.patch.object(manage,'run') as run:
            manage.set_auto('part1',self.profile,False)
        saved=save.call_args.args[2];self.assertEqual(saved['mode'],'migrated');self.assertEqual(saved['disabled_parts'],['part1'])
        run.assert_not_called()

    def test_individual_enable_does_not_remove_global_pause(self):
        self.policy.update(mode='migrated',suspended=True,disabled_parts=['part1'])
        runtime=Path(self.directory.name)/'runtime';file=runtime/'current/deploy/nas/profiles.json';file.parent.mkdir(parents=True);file.write_text(json.dumps(self.index))
        with mock.patch.object(manage,'RUNTIME',str(runtime)),mock.patch.object(recovery,'installed_current',return_value=True),mock.patch.object(manage,'secure_directory',side_effect=lambda p:os.open(self.directory.name,manage.DIR_FLAGS)),mock.patch.object(manage.cutover,'atomic_json') as save,mock.patch.object(manage,'run') as run:
            manage.set_auto('part1',self.profile,True)
        self.assertTrue(save.call_args.args[2]['suspended']);self.assertEqual(save.call_args.args[2]['disabled_parts'],[])
        run.assert_not_called()

    def test_malformed_private_record_is_reported_and_never_started(self):
        self.policy['mode']='migrated'
        (Path(self.profile['report'])/'execution.json').write_text('[]')
        with mock.patch.object(manage,'recover') as recover,self.assertRaises(RuntimeError):recovery.run_all(manage)
        recover.assert_not_called()

    def test_global_pause_command_does_not_wait_for_migration_lock(self):
        with mock.patch.object(sys,'argv',['manage.py','recovery','disable']),mock.patch.object(sys,'platform','linux'),mock.patch.object(manage.os,'geteuid',return_value=0),mock.patch.object(manage.socket,'gethostname',return_value='mx-internal-server'),mock.patch.object(manage,'audit'),mock.patch.object(manage,'migration_lock',side_effect=AssertionError('busy lock')),mock.patch.object(recovery,'disable_all') as disable:
            self.assertEqual(manage.main(),0)
        disable.assert_called_once_with(manage)

    def test_pause_during_batch_prevents_later_starts(self):
        self.policy['mode']='migrated'
        rows=[{'project':'alpha','task':'part1','state':'eligible'},{'project':'beta','task':'part2','state':'eligible'}]
        def stop_after_first(profile):self.policy['suspended']=True
        with mock.patch.object(recovery,'inventory',return_value=(copy.deepcopy(self.policy),rows)),mock.patch.object(manage,'recover',side_effect=stop_after_first) as recover:
            recovery.run_all(manage)
        self.assertEqual(recover.call_count,1)

    def test_installed_code_or_catalog_drift_is_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            src=Path(tmp)/'src';runtime=Path(tmp)/'runtime';p=src/'scripts/nas/recovery.py';p.parent.mkdir(parents=True);p.write_text('safe')
            other=runtime/'current/scripts/nas/recovery.py';other.parent.mkdir(parents=True);other.write_text('safe')
            with mock.patch.object(manage,'ROOT',src),mock.patch.object(manage,'RUNTIME',str(runtime)),mock.patch.object(manage,'runtime_sources',return_value=[p]):
                self.assertTrue(recovery.installed_current(manage));other.write_text('old');self.assertFalse(recovery.installed_current(manage))


if __name__=='__main__':unittest.main()
