# -*- coding: utf-8 -*-
"""SAKIKO 语音桥 —— 纯标准库、零依赖。

作用：把插件 aqua 通道的私有协议（`/tts/file`）翻译成 GPT-SoVITS 的合成请求。

    DSH 插件 ──POST /tts/file?text=…&voice=…&ref_audio_path=…──▶ 本桥 ──▶ GPT-SoVITS api (9880)

为什么需要它：插件的 aqua 协议是 `{aquaUrl}/tts/file?…`，而 GPT-SoVITS 自己的 api
在根路径用另一套参数名，两者不通用；本桥就是中间的适配层（只用 Python 标准库，
不需要装任何依赖，因此可以独立于 GPT-SoVITS 的 python 环境运行）。

配置（优先级：环境变量 > 同目录 bridge.config.json > 内置默认）
    BRIDGE_PORT   本桥监听端口，默认 8000
    GPT_API       GPT-SoVITS api 地址，默认 http://127.0.0.1:9880
    bridge.config.json:
        {
          "gpt_api": "http://127.0.0.1:9880",
          "bridge_port": 8000,
          "voices": {
            "sakiko": { "gpt": "D:\\\\voice\\\\sakiko.ckpt", "sovits": "D:\\\\voice\\\\sakiko.pth" }
          }
        }
    voices 里没写权重的音色 = **零样本克隆模式**（只用参考音频，api 用它启动时载入的基础模型）。

自愈：请求带权重的音色时，若本进程还没注册过，会先调 api 的 `/set_model` 把权重装上
（GPT-SoVITS api 重启后音色注册表会清空，这一步是必须的，忘了就会出现空音频/500）。

接口：
    GET  /health            → {"ok":true,"api":…,"voices":[…],"registered":{…}}   ← 用来做健康检查
    GET  /voices            → 可用音色列表
    POST /tts/file?…        → audio/wav（插件调用）
    POST /ensure_model?voice=sakiko → 手动触发权重注册（幂等）
"""
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------- 配置 ----------------
DEFAULTS = {"gpt_api": "http://127.0.0.1:9880", "bridge_port": 8000, "voices": {}}


def load_config():
    cfg = dict(DEFAULTS)
    path = os.path.join(HERE, "bridge.config.json")
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as fh:
            cfg.update(json.load(fh))
    if os.environ.get("GPT_API"):
        cfg["gpt_api"] = os.environ["GPT_API"]
    if os.environ.get("BRIDGE_PORT"):
        cfg["bridge_port"] = int(os.environ["BRIDGE_PORT"])
    cfg["gpt_api"] = str(cfg.get("gpt_api") or DEFAULTS["gpt_api"]).rstrip("/")
    return cfg


CFG = load_config()
VOICES = CFG.get("voices") or {}
LANG_MAP = {"日文": "ja", "中文": "zh", "英文": "en", "ja": "ja", "zh": "zh", "en": "en"}
PRESET_STEPS = {"fast": 6, "balanced": 10, "quality": 16}

CACHE = {}
CACHE_ORDER = []
CACHE_MAX = 64
LOCK = threading.Lock()
REGISTERED = {}          # voice -> "ok" / 错误字符串（本进程内的注册状态）

# 9880 偶发返回空响应（连接被关闭 / 0 字节 body），GPU 被别的任务抢占时尤其常见。
# 判据：body 短于 MIN_AUDIO_BYTES 一律视为**合成失败**，绝不当作成功音频外发。
MIN_AUDIO_BYTES = 200
MAX_ATTEMPTS = 3
RETRY_DELAYS = (0.5, 1.5)

# 总时限必须小于插件侧 curl 的 --max-time 35，否则会出现
# 「插件已砍断、桥还在重试」的窗口，槽文件里留半截音频。
TOTAL_BUDGET = 30.0
REQUEST_TIMEOUT = 240.0
SET_MODEL_TIMEOUT = 120.0


def log(msg):
    print("%s %s" % (time.strftime("%H:%M:%S"), msg), flush=True)


def _api_get(path, params, timeout):
    """调 api 并**把它的错误体带出来** —— 排障全靠这句（否则只剩 'HTTP Error 400'）。"""
    url = CFG["gpt_api"] + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        raise ValueError("api %s %s%s: %s" % (e.code, CFG["gpt_api"], path, detail or e.reason))


def ensure_model(voice):
    """确保 api 已载入该音色的权重；无权重配置的音色直接跳过（零样本克隆）。"""
    spec = VOICES.get(voice)
    if not isinstance(spec, dict):
        return None
    gpt, sovits = spec.get("gpt"), spec.get("sovits")
    if not gpt and not sovits:
        return None
    with LOCK:
        if REGISTERED.get(voice) == "ok":
            return None
        try:
            params = {}
            if gpt:
                params["gpt_model_path"] = gpt
            if sovits:
                params["sovits_model_path"] = sovits
            body = _api_get("/set_model", params, SET_MODEL_TIMEOUT)
            text = body.decode("utf-8", "replace")
            if "Success" in text:
                REGISTERED[voice] = "ok"
                log("MODEL registered voice=%s" % voice)
                return None
            REGISTERED[voice] = text[:200]
            raise ValueError("set_model failed: " + text[:200])
        except Exception as e:                       # 注册失败就如实报错，不静默降级
            REGISTERED[voice] = str(e)[:200]
            log("MODEL register error voice=%s: %s" % (voice, str(e)[:200]))
            raise


def _fetch_once(payload, timeout):
    req = urllib.request.Request(CFG["gpt_api"] + "/?" + urllib.parse.urlencode(payload))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        raise ValueError("api %s: %s" % (e.code, detail or e.reason))


def _synth_with_retry(payload):
    """带退避重试的合成；总耗时不超过 TOTAL_BUDGET。返回 (bytes, attempts)。"""
    last_err = None
    deadline = time.monotonic() + TOTAL_BUDGET
    for attempt in range(1, MAX_ATTEMPTS + 1):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            log("SYNTH giveup: budget %.1fs exhausted before attempt=%d" % (TOTAL_BUDGET, attempt))
            break
        try:
            data = _fetch_once(payload, min(REQUEST_TIMEOUT, remaining))
        except Exception as e:
            last_err = e
            log("SYNTH retry: attempt=%d/%d error: %s" % (attempt, MAX_ATTEMPTS, str(e)[:200]))
        else:
            if len(data) >= MIN_AUDIO_BYTES:
                if attempt > 1:
                    log("SYNTH retry ok attempt=%d bytes=%d" % (attempt, len(data)))
                return data, attempt
            last_err = ValueError("empty audio body (%d bytes)" % len(data))
            log("SYNTH retry: attempt=%d/%d empty body (%d bytes)" % (attempt, MAX_ATTEMPTS, len(data)))
        if attempt < MAX_ATTEMPTS:
            gap = RETRY_DELAYS[attempt - 1]
            if deadline - time.monotonic() <= gap:
                log("SYNTH giveup: no room for retry after attempt=%d" % attempt)
                break
            time.sleep(gap)
    raise last_err if last_err is not None else ValueError("synthesis failed")


def _cache_get(key):
    return CACHE.get(key)


def _cache_put(key, data):
    CACHE[key] = data
    CACHE_ORDER.append(key)
    while len(CACHE_ORDER) > CACHE_MAX:
        CACHE.pop(CACHE_ORDER.pop(0), None)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def _handle(self):
        try:
            u = urllib.parse.urlparse(self.path)
            q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}

            if u.path == "/health":
                api_ok = False
                try:
                    _api_get("/", {}, 5)
                    api_ok = True
                except Exception:
                    try:                                  # 根路径报错也算活着（只是参数不全）
                        _api_get("/docs", {}, 5)
                        api_ok = True
                    except Exception:
                        api_ok = False
                return self._send(200, json.dumps({
                    "ok": True, "api": api_ok, "api_url": CFG["gpt_api"],
                    "voices": sorted(VOICES.keys()) or ["(零样本克隆，未配置音色)"],
                    "registered": dict(REGISTERED),
                }, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

            if u.path == "/voices":
                return self._send(200, json.dumps(sorted(VOICES.keys()), ensure_ascii=False).encode("utf-8"),
                                  "application/json; charset=utf-8")

            if u.path == "/ensure_model":
                voice = q.get("voice", "sakiko")
                try:
                    ensure_model(voice)
                    return self._send(200, json.dumps({"ok": True, "voice": voice, "registered": REGISTERED.get(voice)}).encode(),
                                      "application/json")
                except Exception as e:
                    return self._send(500, json.dumps({"error": str(e)[:300]}).encode(), "application/json")

            if u.path != "/tts/file":
                return self._send(404, b'{"detail":"Not Found"}', "application/json")

            text = q.get("text", "")
            if not text:
                return self._send(400, b"missing text", "text/plain")
            voice = q.get("voice") or (sorted(VOICES.keys())[0] if VOICES else "default")
            ref = q.get("ref_audio_path", "")
            prompt = q.get("prompt_text", "")
            key = (voice, text, ref, prompt, q.get("preset", ""))
            data = _cache_get(key)
            if data is None:
                ensure_model(voice)
                payload = {
                    "text": text,
                    "text_language": LANG_MAP.get(q.get("text_language", "日文"), "ja"),
                    "refer_wav_path": ref,
                    "prompt_text": prompt,
                    "prompt_language": LANG_MAP.get(q.get("prompt_language", "日文"), "ja"),
                    "top_k": 20, "top_p": 0.8, "temperature": 0.8,
                    "speed": float(os.environ.get("SPEED_FACTOR", "1.0")),
                    "sample_steps": PRESET_STEPS.get(q.get("preset"), int(os.environ.get("SAMPLE_STEPS", "10"))),
                    "if_sr": False,
                }
                data, attempts = _synth_with_retry(payload)
                _cache_put(key, data)
                log("SYNTH ok %d bytes attempts=%d voice=%s text=%s…" % (len(data), attempts, voice, text[:14]))
            if not data or len(data) < MIN_AUDIO_BYTES:      # 缓存路径的兜底保险
                raise ValueError("invalid audio body (%d bytes)" % (len(data) if data else 0))
            self._send(200, data, "audio/wav")
        except Exception as e:
            self._send(500, json.dumps({"error": str(e)[:300]}).encode(), "application/json")


if __name__ == "__main__":
    port = int(CFG["bridge_port"])
    log("bridge on 127.0.0.1:%d  api=%s  voices=%s" % (port, CFG["gpt_api"], sorted(VOICES.keys()) or "(zero-shot)"))
    print("READY", flush=True)          # 就绪握手：调用方可据此判断已开始监听
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
