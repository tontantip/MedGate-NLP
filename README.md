# MedGate AI — 5-Tier Clinical Triage & Routing CDSS Demo

Interactive web demonstration for **MedGate AI** (*DADS7203 Natural Language Processing Final Project*), comparing five clinical triage & specialty routing architectures on real Seed 42 test encounters from `sweatSmile/medical-symptom-triage`:

- **Tier 1:** Jev AI (`typesafe/jev-1.13`) — Discriminative System 1 Frontline Engine
- **Tier 2:** Local Fine-Tuned LLM (`Qwen2.5-3B-Instruct` 4-bit QLoRA)
- **Tier 3:** Commercial Cloud LLM (`Claude Sonnet 5.5` 3-shot)
- **Tier 4:** Hybrid Local Cascaded Pipeline (`Jev AI + Local Qwen2.5-3B`, Strict Gate $\theta_u \ge 0.98, \theta_s \ge 0.80$)
- **Tier 5:** Hybrid Cloud Cascaded Pipeline (`Jev AI + Claude Sonnet 5.5`, Strict Gate $\theta_u \ge 0.98, \theta_s \ge 0.80$)

## Live Demo
Deployed via GitHub Pages: `https://tontantip.github.io/MedGate-NLP/`
