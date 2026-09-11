"""세션 데몬 런처.

PowerShell 의 Start-Process 로는 CREATE_NO_WINDOW 를 줄 수 없어서 한 단계 거친다.
이 스크립트는 pythonw(창 없음)로 실행되고, 데몬만 python.exe + CREATE_NO_WINDOW 로
띄운 뒤 즉시 종료한다 → 콘솔 flash 없이 "콘솔 있는 데몬"을 얻는다.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import daemon_client  # noqa: E402

daemon_client.spawn_daemon()
