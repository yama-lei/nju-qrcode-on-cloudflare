"""Obtain a fresh official QR authorization and update private deployment secrets."""
import base64
import json
import getpass
import sys
import re
import secrets
import subprocess
import time
import uuid
from pathlib import Path
from urllib.parse import urlencode

from PIL import Image

root = Path(__file__).resolve().parent.parent
private = root / ".private"
private.mkdir(exist_ok=True)
jar = private / "authorize-cookies.txt"
auth = "https://authserver.nju.edu.cn/authserver"
service = "https://qrcode.nju.edu.cn:443/api/h5"
login = auth + "/login?" + urlencode({"display": "qrLogin", "service": service})

def curl(url, fields=None, extra=()):
    cmd = ["curl", "-fsSL", "--max-time", "25", "-A", "wisedu", "-b", str(jar), "-c", str(jar)]
    for k, v in (fields or {}).items():
        cmd += ["--data-urlencode", k + "=" + v]
    result = subprocess.run(cmd + list(extra) + [url], capture_output=True, timeout=30)
    if result.returncode:
        raise RuntimeError("University request failed; credentials are not printed")
    return result.stdout

def print_qrcode(path, stream=sys.stdout):
    """Render the official PNG at module resolution with a four-module quiet zone."""
    with Image.open(path) as image:
        dark = image.convert("L").point(lambda value: 255 if value < 128 else 0)
        bounds = dark.getbbox()
        if not bounds:
            raise ValueError("二维码图片为空")
        left, top, right, bottom = bounds
        end = left
        while end < right and dark.getpixel((end, top)):
            end += 1
        pitch = (end - left) / 7
        if pitch <= 0:
            raise ValueError("无法识别二维码模块")
        size = round((right - left) / pitch)
        modules = [[False] * (size + 8) for _ in range(size + 8)]
        for y in range(size):
            for x in range(size):
                modules[y + 4][x + 4] = bool(dark.getpixel((round(left + (x + 0.5) * pitch), round(top + (y + 0.5) * pitch))))
    if len(modules) % 2:
        modules.append([False] * len(modules[0]))
    for upper, lower in zip(modules[::2], modules[1::2]):
        # Black foreground on white background remains scannable in dark terminals.
        print("\033[30;47m" + "".join(" ▄▀█"[2 * a + b] for a, b in zip(upper, lower)) + "\033[0m", file=stream)
    stream.flush()


def main():
    secrets_path = private / "deploy-secrets.json"
    if secrets_path.exists():
        values = json.loads(secrets_path.read_text())
    else:
        password_path = private / "web-password.txt"
        password = password_path.read_text().rstrip("\r\n") if password_path.exists() else getpass.getpass("设置网页访问密码：")
        if not password.strip() or len(password) > 128:
            raise SystemExit("网页密码不能为空，且不能超过 128 字符")
        values = {"WEB_PASSWORD": password, "SESSION_KEY": secrets.token_hex(32)}
    html = curl(login).decode()
    execution = re.search(r'name="execution" value="([^"]+)"', html).group(1)
    token = curl(auth + "/qrCode/getToken").decode().strip()
    image = root / "qrcode.png"
    image.write_bytes(curl(auth + "/qrCode/getCode?" + urlencode({"uuid": token})))
    print_qrcode(image)
    print(f"二维码已保存：{image}\n请用已登录的南京大学 APP 扫码，并在手机确认登录。", flush=True)
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        status = curl(auth + "/qrCode/getStatus.htl?" + urlencode({"uuid": token})).decode().strip()
        if status == "1":
            break
        if status == "3":
            raise SystemExit("QR expired; rerun this script")
        time.sleep(2)
    else:
        raise SystemExit("Authorization timed out; rerun this script")
    curl(login, {"uuid": token, "execution": execution, "cllt": "qrLogin", "dllt": "generalLogin", "lt": "",
                 "_eventId": "submit", "rmShown": "1", "rememberMe": "true"})
    ticket = curl("https://qrcode.nju.edu.cn/api/check", extra=["-X", "POST"]).decode().strip().strip('"')
    exchange = json.loads(curl("https://qrcode.nju.edu.cn/code/v1/qrexchange", extra=["-H", "Ticket: " + ticket, "-H", "Content-Type: application/json", "--data", "{}"]))
    jwt = exchange["jwt"]
    claims = json.loads(base64.urlsafe_b64decode(jwt.split(".")[1] + "==="))
    if not isinstance(claims.get("stuempno"), str) or not claims["stuempno"]:
        raise SystemExit("学校未返回有效账号")
    if "CAMPUS_BOOTSTRAP" in values and json.loads(values["CAMPUS_BOOTSTRAP"])["owner"] != claims["stuempno"]:
        raise SystemExit("Authorized account does not match the configured owner")
    cookies = []
    for line in jar.read_text().splitlines():
        if not line or line.startswith("#") and not line.startswith("#HttpOnly_"):
            continue
        c = line.replace("#HttpOnly_", "").split("\t")
        if c[0] in ["qrcode.nju.edu.cn", "authserver.nju.edu.cn"]:
            cookies.append(dict(host=c[0], path=c[2], name=c[5], value=c[6]))
    values["CAMPUS_BOOTSTRAP"] = json.dumps(dict(seed=str(uuid.uuid4()), owner=claims["stuempno"],
        ticket=exchange["ticket"], jwt=jwt, jwtExpiresAt=0, cookies=cookies), separators=(",", ":"))
    secrets_path.write_text(json.dumps(values))
    secrets_path.chmod(0o600)
    jar.chmod(0o600)
    print("Authorization saved privately. Deploy with: cf deploy --secrets-file .private/deploy-secrets.json")


if __name__ == "__main__":
    main()
