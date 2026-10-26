import importlib.machinery
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('game_helper', 'deploy/vpnbot-game-helper')
helper = types.ModuleType(loader.name)
loader.exec_module(helper)


class RestoreRulesTest(unittest.TestCase):
    def test_restore_adds_missing_admin_route_without_changing_user_states(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(helper, 'BASE', Path(directory)), \
             patch.object(helper, 'states', return_value=[]), \
             patch.object(helper, 'has_rule', return_value=False), \
             patch.object(helper, 'run') as run, \
             patch.object(sys, 'argv', ['vpnbot-game-helper', 'restore']):
            helper.main()
        run.assert_called_once_with('ip', 'rule', 'add', 'pref', '12002',
                                    'from', '10.219.0.2/32', 'lookup', '23001')

    def test_restore_does_not_duplicate_existing_admin_route(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(helper, 'BASE', Path(directory)), \
             patch.object(helper, 'states', return_value=[]), \
             patch.object(helper, 'has_rule', return_value=True), \
             patch.object(helper, 'run') as run, \
             patch.object(sys, 'argv', ['vpnbot-game-helper', 'restore']):
            helper.main()
        run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
