# MobileCLIP2-S0 POC results

## Environment

- CPU: AMD Ryzen 5 5600X
- GPU: NVIDIA GeForce RTX 2060 SUPER
- Python: 3.14
- PyTorch: 2.14.0+cu126
- Model: `timm/MobileCLIP2-S0-OpenCLIP`
- OpenCLIP: 3.2.0
- Transformers: 4.57.6

## Results

### Zero-shot text labels

Five synthetic UI states, three variants per state:

- Top-1 accuracy: **20% (3/15)**
- Steady-state CUDA inference: **~22.6 ms/frame**
- CUDA peak allocated: **~316 MB**
- Model load after cache: **~3.1 s**

Conclusion: raw text-prompt zero-shot classification is not reliable enough for Relay QA decisions.

### Few-shot image prototypes

Leave-one-out classification using image embeddings and two same-class reference examples:

- Accuracy: **100% (15/15)**
- CUDA image encoding: **~24.2 ms/frame**
- CUDA peak allocated: **~313 MB**

This set is intentionally easy because variants from the same class share visual structure. It proves the embedding path works, not production correctness.

### Hard holdout

Reference prototypes are built from the base fixtures; holdout screens change layout, wording, theme, and visual treatment.

Before adding an unknown class:

- Accuracy: **80% (8/10)**
- CUDA: **~21.8 ms/frame**
- CPU: **~49.2 ms/frame**
- CUDA peak allocated: **~313 MB**

After adding three generic non-app reference screens plus two unknown holdouts:

- Accuracy: **83.3% (10/12)**
- Current real desktop screenshot: classified as **unknown**
- Real desktop margin: **0.053**

Two hard holdout mistakes had low top1-vs-top2 margins, which supports using a reject/escalation gate.

## Margin gate on 12 hard holdouts

| Minimum margin | Local coverage | Accuracy of accepted decisions |
| ---: | ---: | ---: |
| 0.00 | 100% | 83.3% |
| 0.02 | 83% | 90.0% |
| 0.03 | 75% | 100% |
| 0.05 | 67% | 100% |
| 0.08 | 42% | 100% |

These percentages are from only 12 synthetic holdout images and must not be treated as production accuracy.

## POC conclusion

MobileCLIP2-S0 is **not useful here as a generic zero-shot visual decision model**. It is promising as a **domain-specific image embedding classifier**:

```text
screenshot
  -> MobileCLIP2-S0 image embedding
  -> compare with stored Buddy2 state prototypes
  -> high margin: local decision
  -> low margin / unknown: ChatGPT Vision
```

The important advantage is that runtime classification can use image embeddings and precomputed prototypes; the text encoder does not need to make the decision.

## Go/no-go test for Buddy2

Before integrating into Relay, collect a real labeled Buddy2 dataset and keep train/reference screenshots separate from evaluation screenshots. Include loading, error, empty, normal, modal, selected/unselected states, theme/font-scale variants, and hard negatives.

The useful production metric is not raw top-1 accuracy. Measure:

- precision of decisions accepted locally;
- local coverage at that precision;
- false-positive rate for unknown screens;
- latency and memory while Relay/Desktop/ADB are active.

A reasonable next gate is to target very high accepted precision (for example >=99%) and then measure how much coverage remains.
