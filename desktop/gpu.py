import json
import sys
import time

import torch

if not torch.cuda.is_available():
    raise RuntimeError("CUDA is unavailable. Install a compatible NVIDIA driver and CUDA-enabled PyTorch.")

if sys.argv[1] == "probe":
    print(json.dumps({"name": torch.cuda.get_device_name(0)}))
else:
    seconds = int(sys.argv[1])
    if not 5 <= seconds <= 300:
        raise ValueError("Duration must be 5 to 300 seconds.")
    torch.manual_seed(42)
    a = torch.randn((2048, 2048), device="cuda", dtype=torch.float32)
    b = torch.randn((2048, 2048), device="cuda", dtype=torch.float32)
    torch.cuda.synchronize()
    start = time.monotonic()
    count = 0
    while time.monotonic() - start < seconds:
        c = torch.mm(a, b)
        torch.cuda.synchronize()
        count += 1
    elapsed = round((time.monotonic() - start) * 1000)
    print(json.dumps({
        "elapsedMs": elapsed,
        "result": f"CUDA FP32: {count} matrix multiplications (2048 x 2048). Device: {torch.cuda.get_device_name(0)}. Result sample: {c[0, 0].item():.6f}"
    }))
