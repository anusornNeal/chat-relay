# MobileCLIP2-S0 visual decision POC

Purpose: test whether a small local image-text model can act as a first-pass UI-state classifier before escalating ambiguous screenshots to ChatGPT Vision.

## Isolation

This POC is outside the production Relay runtime. It does not add Python packages or model weights to the npm runtime.

## Model

- OpenCLIP-compatible `timm/MobileCLIP2-S0-OpenCLIP`
- Input resolution: 256x256
- Output: normalized image embeddings / image-text similarity
- License: Apple AMLR (verify suitability before production distribution)
- This is not a GUI grounding model and its similarity values are not calibrated QA probabilities.

## Setup

Use a separate venv. The tested environment required `transformers<5`; this POC pins the exact tested version because OpenCLIP 3.2.0 was incompatible with the machine's Transformers 5.17 tokenizer API.

```powershell
python -m pip install -r requirements.txt
python make_samples.py
python make_hard_samples.py
```

## Benchmarks

Zero-shot text-label baseline:

```powershell
python benchmark.py --device cuda --repeat 20 --json-out result.json
```

Few-shot image prototype smoke test:

```powershell
python prototype_benchmark.py --device cuda --json-out prototype.json
```

Hard holdout:

```powershell
python prototype_holdout.py --device cuda --json-out holdout.json
python analyze_thresholds.py holdout.json
```

Optional real-screen probe:

```powershell
python prototype_holdout.py --device cuda --real-image path\to\screenshot.jpg
```

See `RESULTS.md` for the measured POC results.

## Intended decision policy

Do not trust nearest-class alone. The intended architecture is:

```text
MobileCLIP image embedding
  -> compare against precomputed domain prototypes
  -> margin/confidence gate
     -> accepted: local state decision
     -> rejected/unknown: ChatGPT Vision
```

Production thresholds must be calibrated on real Buddy2 screenshots, not the synthetic POC fixtures.
