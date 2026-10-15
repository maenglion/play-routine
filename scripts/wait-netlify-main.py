#!/usr/bin/env python3
"""특정 main 커밋의 Netlify 자동 게시를 제한시간 안에서 확인한다. 비밀값은 출력하지 않는다."""
import argparse
import json
import os
import sys
import time
from pathlib import Path
import requests

parser = argparse.ArgumentParser()
parser.add_argument("commit")
parser.add_argument("--site", default="8398c432-44d5-4c46-b7c0-218d2e574cc4")
parser.add_argument("--timeout", type=int, default=600)
parser.add_argument("--output", required=True)
args = parser.parse_args()
token = os.environ.get("NETLIFY_AUTH_TOKEN")
if not token:
    sys.exit("Netlify 인증 환경변수가 없습니다.")
session = requests.Session()
session.headers["Authorization"] = "Bearer " + token
base = "https://api.netlify.com/api/v1/sites/" + args.site
started = time.monotonic()
progress = started
last = None
while time.monotonic() - started < args.timeout:
    try:
        result = session.get(base + "/deploys", params={"per_page": 20}, timeout=30)
        if result.status_code in (401, 403):
            sys.exit("Netlify 조회 권한을 확인해야 합니다.")
        result.raise_for_status()
        candidates = [d for d in result.json() if str(d.get("commit_ref", "")).startswith(args.commit) and d.get("context") == "production" and d.get("branch") == "main"]
        deploy = candidates[0] if candidates else None
        status = deploy.get("state", "UNKNOWN") if deploy else "WAITING_FOR_GIT_BUILD"
        if status != last:
            progress = time.monotonic()
            last = status
        print(f"main 자동배포: {status}, 경과 {int(time.monotonic()-started)}초, 최근 진행 후 {int(time.monotonic()-progress)}초", flush=True)
        if status in ("error", "rejected", "canceled"):
            sys.exit("Netlify 자동배포가 실패 또는 취소됐습니다. 빌드 로그를 확인하세요.")
        if status == "ready":
            site_result = session.get(base, timeout=30)
            site_result.raise_for_status()
            site = site_result.json()
            if (site.get("published_deploy") or {}).get("id") == deploy["id"]:
                safe = {"deploy_id": deploy["id"], "commit_ref": deploy.get("commit_ref"), "url": site.get("ssl_url"), "state": status, "branch": "main", "automatic_builds_enabled": not (site.get("build_settings") or {}).get("stop_builds", False)}
                Path(args.output).write_text(json.dumps(safe, ensure_ascii=False, indent=2) + "\n")
                print("main 자동 빌드·공개 게시 검증 완료", flush=True)
                break
    except requests.RequestException:
        print("일시적인 배포 조회 오류, 제한시간 내 다시 확인합니다.", flush=True)
    time.sleep(20)
else:
    sys.exit("자동배포 검증 제한시간을 초과했습니다. 재실행 전 기존 작업 상태를 확인하세요.")
