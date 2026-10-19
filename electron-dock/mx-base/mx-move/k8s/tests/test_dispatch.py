"""Public entry points must not interpret K8s subcommands as applications."""
from pathlib import Path
import subprocess
import unittest


class DispatchTests(unittest.TestCase):
    def scripts(self):
        module = Path(__file__).parents[2]
        return (module / 'scripts/manage.sh', module.parent / 'scripts/manage.sh')

    def test_k8s_help_lists_every_stage_without_host_access(self):
        for script in self.scripts():
            result = subprocess.run(['bash', str(script), 'k8s', '--help'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(result.returncode, 0, result.stderr)
            for action in ('inventory', 'plan', 'runtime-check', 'prepare-runtime', 'install-runtime',
                           'cutover-check', 'prepare-check', 'migrate', 'status', 'resume', 'verify'):
                self.assertIn(action.encode(), result.stdout)

    def test_cutover_help_reaches_its_parser_without_mutations(self):
        for script in self.scripts():
            for action in ('cutover-check', 'prepare-check', 'migrate', 'status', 'resume', 'verify'):
                with self.subTest(script=str(script), action=action):
                    result = subprocess.run(['bash', str(script), 'k8s', action, '--help'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn(b'cutover-check,prepare-check,migrate,status,resume,verify', result.stdout)
                    self.assertNotIn('未知应用'.encode(), result.stderr)

    def test_existing_inventory_and_candidate_help_remain_available(self):
        for script in self.scripts():
            for action, option in (('plan', '--measure'), ('install-runtime', '--prepared')):
                result = subprocess.run(['bash', str(script), 'k8s', action, '--help'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(option.encode(), result.stdout)


if __name__ == '__main__':
    unittest.main()
