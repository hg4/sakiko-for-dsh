# -*- coding: utf-8 -*-
"""SAKIKO 语音栈一键体检 —— 纯标准库，任何 python 都能跑（不依赖 GPT-SoVITS 的环境）。

装之前跑一次（知道缺什么）、装完再跑一次（确认真的能用）。
每一项都给 [OK] / [!!] / [--] + 判据 + 修法，最后给出退出码（0=关键项全过）。

用法：
    python preflight.py                          # 用默认路径体检
    python preflight.py --voice-root D:\\voice     # 指定语音根目录
    python preflight.py --json                   # 机器可读（给 agent 用）
    python preflight.py --allow-no-gpu           # 没有 N 卡时（CPU 推理，很慢但能跑）

关键判据（避免"端口通就算成功"）：
    * torch.cuda.is_available() 必须是 True（否则 -d cuda 起不来，得改 -d cpu）
    * g2p_en 首次调用必须 <5 秒：含拉丁字母的文本会走英语 G2P，缺 NLTK 数据时
      它会联网下载并卡死约 2 分钟，表现为"纯假名正常、含 DSH/GPT 的句子必失败"
    * 端到端合成拿到的必须是 32kHz RIFF/WAVE（Edge 回退是 MP3、VOICEVOX 是 24kHz）
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = []


def add(level, name, detail, fix=""):
    RESULTS.append({"level": level, "check": name, "detail": detail, "fix": fix})


def ok(name, detail):
    add("OK", name, detail)


def bad(name, detail, fix):
    add("!!", name, detail, fix)


def warn(name, detail, fix=""):
    add("--", name, detail, fix)


def port_listening(port, host="127.0.0.1"):
    s = socket.socket()
    s.settimeout(1.5)
    try:
        s.connect((host, port))
        return True
    except Exception:
        return False
    finally:
        s.close()


def http_get(url, timeout=8):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.status, r.read()


def run(cmd, timeout=120, cwd=None):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd,
                       encoding="utf-8", errors="replace",
                       env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    return p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice-root", default=os.path.join(os.path.expanduser("~"), ".dsh", "sakiko", "voice"))
    ap.add_argument("--config", default=os.path.join(os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh"),
                                                     "sakiko", "config", "sakiko.json"))
    ap.add_argument("--bridge", default="http://127.0.0.1:8000")
    ap.add_argument("--api", default="http://127.0.0.1:9880")
    ap.add_argument("--allow-no-gpu", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    root = os.path.abspath(args.voice_root)
    repo = os.path.join(root, "GPT-SoVITS-main")
    venv_py = os.path.join(root, "env", "Scripts", "python.exe")
    bridge_cfg = os.path.join(HERE, "bridge.config.json")

    # ---- 1. 目录与解释器 ----
    if not os.path.isdir(root):
        bad("语音根目录", "不存在: %s" % root, "先建目录：mkdir \"%s\"（或用 --voice-root 指向别处）" % root)
    else:
        ok("语音根目录", root)

    if os.path.isfile(venv_py):
        ok("专用 Python 环境", venv_py)
    else:
        py = sys.executable
        warn("专用 Python 环境", "未找到 %s，将用当前解释器 %s 探测依赖" % (venv_py, py),
             "按 SKILL.md 第 1 步建 venv：py -3.10 -m venv \"%s\"" % os.path.join(root, "env"))
        venv_py = py

    # ---- 2. 依赖与 GPU ----
    if os.path.isfile(venv_py):
        rc, out, err = run([venv_py, "-c",
                            "import sys,torch,transformers;"
                            "print(sys.version.split()[0]);print(torch.__version__);"
                            "print(torch.cuda.is_available());print(transformers.__version__)"], timeout=180)
        if rc == 0:
            lines = out.splitlines()
            pyver, torchver, cudaok, tfver = (lines + ["?", "?", "False", "?"])[:4]
            if pyver.startswith("3.10"):
                ok("Python 版本", pyver)
            else:
                warn("Python 版本", "%s（建议 3.10.x，GPT-SoVITS 在该版本实测可用）" % pyver)
            if "+cu" in torchver:
                ok("torch", torchver)
            else:
                bad("torch", "%s（不是 CUDA 版）" % torchver,
                    "重装：pip install torch==2.5.1 torchaudio==2.5.1 --index-url https://mirrors.nju.edu.cn/pytorch/whl/cu121/")
            if cudaok == "True":
                ok("CUDA 可用", torchver)
            elif args.allow_no_gpu:
                warn("CUDA 可用", "False（--allow-no-gpu：改用 -d cpu 启动 api，合成会很慢）")
            else:
                bad("CUDA 可用", "False", "装 N 卡驱动/CUDA 版 torch；或加 --allow-no-gpu 走 CPU（很慢）")
            tf_major_minor = tuple(int(x) for x in tfver.split(".")[:2] if x.isdigit()) if tfver[0].isdigit() else (0, 0)
            if tf_major_minor >= (4, 57):
                bad("transformers", "%s（>=4.57 会强制 torch>=2.6，与本项目 torch 2.5.1 冲突）" % tfver,
                    "pip install transformers==4.51.3")
            else:
                ok("transformers", tfver)
        else:
            # 只报最后一行（真正的异常原因），traceback 前几行对排障没用
            tail = [x for x in (err or out).strip().splitlines() if x.strip()]
            bad("依赖导入", tail[-1][:200] if tail else "(无输出)",
                "按 SKILL.md 第 1 步装依赖（先装 torch 再装 requirements）")

        # NLTK / g2p_en 计时（含拉丁字母文本的必经之路）
        rc, out, err = run([venv_py, "-c",
                            "import time;from g2p_en import G2p;t=time.time();g=G2p();"
                            "r=g('DSH');print(round(time.time()-t,2));print(r[:40])"], timeout=180)
        if rc == 0:
            secs = float(out.splitlines()[0])
            if secs < 5:
                ok("英语 G2P（NLTK 数据）", "%.2fs（<5s 合格）" % secs)
            else:
                bad("英语 G2P（NLTK 数据）", "%.1fs（缺 NLTK 数据，正在联网下载 → 会卡死约 2 分钟）" % secs,
                    "按 SKILL.md 第 4 步补 %%USERPROFILE%%\\nltk_data\\ 下的 cmudict.zip 与 "
                    "averaged_perceptron_tagger.zip（必须是 .zip 本身），补完**重启 api**")
        else:
            bad("英语 G2P（NLTK 数据）", (err or out)[:200], "同上")

    # ---- 3. 基础模型 ----
    pm = os.path.join(repo, "GPT_SoVITS", "pretrained_models")
    need = {
        "chinese-hubert-base": "语音内容编码器",
        "chinese-roberta-wwm-ext-large": "中/日文文本编码器",
        os.path.join("sv", "pretrained_eres2netv2w24s4ep4.ckpt"): "说话人相似度",
        os.path.join("fast_langdetect", "lid.176.ftz"): "语种检测",
    }
    missing = [k for k in need if not os.path.exists(os.path.join(pm, k))]
    if not os.path.isdir(pm):
        bad("基础模型目录", "不存在: %s" % pm, "按 SKILL.md 第 2 步下载基础模型")
    elif missing:
        bad("基础模型", "缺 %d 项: %s" % (len(missing), ", ".join(missing)), "按 SKILL.md 第 2 步补下（缺任一项都会启动/推理失败）")
    else:
        ok("基础模型", "%d 项齐全（v2ProPlus 推理必需）" % len(need))
    if os.path.isdir(os.path.join(pm, "models--nvidia--bigvgan_v2_24khz_100band_256x")):
        warn("BigVGAN 声码器", "存在，但 v2ProPlus 用不到（只有 v3 需要），可不下")

    # ---- 4. 音色权重与参考音频（读桥的配置） ----
    voices = {}
    if os.path.isfile(bridge_cfg):
        try:
            with open(bridge_cfg, encoding="utf-8") as fh:
                voices = (json.load(fh).get("voices") or {})
            ok("桥配置", bridge_cfg)
        except Exception as e:
            bad("桥配置", "解析失败: %s" % e, "检查 bridge.config.json 的 JSON 语法")
    else:
        warn("桥配置", "未找到 %s" % bridge_cfg,
             "从 bridge.config.example.json 复制一份，填好权重与端口（零样本克隆可以不填权重）")
    for v, spec in (voices or {}).items():
        gpt, sovits = (spec or {}).get("gpt"), (spec or {}).get("sovits")
        if gpt and not os.path.isfile(gpt):
            bad("音色权重 %s" % v, ".ckpt 不存在: %s" % gpt, "修正 bridge.config.json 里的路径")
        elif sovits and not os.path.isfile(sovits):
            bad("音色权重 %s" % v, ".pth 不存在: %s" % sovits, "修正 bridge.config.json 里的路径")
        elif gpt or sovits:
            ok("音色权重 %s" % v, "成对存在")
        else:
            warn("音色权重 %s" % v, "未配权重 → 零样本克隆模式（只用参考音频）")

    # ---- 5. 插件侧配置 ----
    cfg = {}
    if os.path.isfile(args.config):
        try:
            with open(args.config, encoding="utf-8") as fh:
                cfg = json.load(fh)
        except Exception as e:
            bad("插件配置", "解析失败: %s" % e, args.config)
    else:
        bad("插件配置", "不存在: %s" % args.config, "先启动一次 DSH（插件会生成默认配置）")
    if cfg:
        if cfg.get("provider") != "aqua":
            bad("插件通道", "provider=%s（不是 aqua）" % cfg.get("provider"), "把 provider 改成 \"aqua\"（改配置时 DSH 必须处于停止状态）")
        else:
            ok("插件通道", "provider=aqua → %s" % cfg.get("aquaUrl"))
        ref = cfg.get("aquaRefAudio") or ""
        if ref and not os.path.isfile(ref):
            bad("参考音频", "配置里的路径不存在: %s" % ref, "填服务端可读的绝对路径（WAV 最稳）")
        elif ref:
            try:
                with wave.open(ref) as w:
                    ok("参考音频", "%s  %.2fs %dHz %dch" % (os.path.basename(ref), w.getnframes() / max(1, w.getframerate()),
                                                          w.getframerate(), w.getnchannels()))
            except Exception as e:
                warn("参考音频", "存在但不是标准 WAV（%s）" % str(e)[:60], "转成 WAV 最稳：ffmpeg -i in.mp3 -ar 24000 -ac 1 out.wav")
        else:
            bad("参考音频", "aquaRefAudio 为空", "填参考音频的绝对路径（5~30 秒、单人、无 BGM）")
        if not (cfg.get("aquaPromptText") or "").strip():
            bad("参考文稿", "aquaPromptText 为空", "填与参考音频**逐字一致**的日文文稿（不一致会明显跑音）")
        else:
            ok("参考文稿", (cfg.get("aquaPromptText") or "")[:28] + "…")
        if cfg.get("aquaVoice"):
            ok("音色名", cfg.get("aquaVoice"))
        else:
            warn("音色名", "aquaVoice 为空", "填 bridge.config.json 里的音色键名（如 sakiko）")

    # ---- 6. 服务与端口 ----
    api_up = port_listening(9880)
    bridge_up = port_listening(8000)
    if api_up:
        try:
            http_get(args.api + "/docs", 5)
            ok("GPT-SoVITS api :9880", "在监听且可访问")
        except Exception:
            warn("GPT-SoVITS api :9880", "端口在监听但 HTTP 无响应（可能正在加载模型）")
    else:
        bad("GPT-SoVITS api :9880", "未监听", "按 SKILL.md 第 6 步启动（cwd 必须是 GPT-SoVITS-main）")
    if bridge_up:
        try:
            st, body = http_get(args.bridge + "/health", 8)
            info = json.loads(body.decode("utf-8", "replace"))
            if info.get("api") is None:
                ok("语音桥 :8000", "ok=%s（未上报 api/voices 字段 = 旧版桥，功能可用；本 skill 附带的桥会多报两项）" % info.get("ok"))
            else:
                ok("语音桥 :8000", "ok=%s api=%s voices=%s" % (info.get("ok"), info.get("api"), info.get("voices")))
        except Exception as e:
            bad("语音桥 :8000", "端口在监听但 /health 异常: %s" % str(e)[:80], "看桥的窗口/日志输出")
    else:
        bad("语音桥 :8000", "未监听", "按 SKILL.md 第 7 步启动 bridge_tts.py（端口被占则改 BRIDGE_PORT 并同步改 aquaUrl）")

    # ---- 输出 ----
    if args.json:
        print(json.dumps({"results": RESULTS,
                          "critical_failed": [r for r in RESULTS if r["level"] == "!!"]}, ensure_ascii=False, indent=2))
    else:
        print("=" * 62)
        print("SAKIKO 语音栈体检    语音根目录: %s" % root)
        print("=" * 62)
        for r in RESULTS:
            print("[%s] %-22s %s" % (r["level"], r["check"], r["detail"]))
            if r["fix"]:
                print("      └ 修法: %s" % r["fix"])
        n_bad = len([r for r in RESULTS if r["level"] == "!!"])
        print("-" * 62)
        print("关键项失败: %d    警告: %d" % (n_bad, len([r for r in RESULTS if r["level"] == "--"])))
        print("结论: " + ("关键项全部通过 ✅（仍须做 SKILL.md 的端到端合成验证）" if n_bad == 0
                          else "还有 %d 项关键问题未解决 ❌" % n_bad))
    return 1 if any(r["level"] == "!!" for r in RESULTS) else 0


if __name__ == "__main__":
    sys.exit(main())
