"""Session-daemon launcher.

PowerShell's Start-Process can't pass CREATE_NO_WINDOW, so we go through this step.
Run under pythonw (no window), it spawns the daemon with python.exe + CREATE_NO_WINDOW
and exits immediately -> a daemon that has a console, without a console flash.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import daemon_client  # noqa: E402

daemon_client.spawn_daemon()
