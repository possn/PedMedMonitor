# PedMedMonitor (v2)

PWA (GitHub Pages) para simulação PK/PD (modelo 1-compartimento) e apoio **educacional** à monitorização de:
- Vancomicina: **AUC/MIC**, **Pico/Vale (proxy)**, **Perfusão contínua (Css)**
- Gentamicina, Amicacina, Tobramicina: **dose única diária** e **múltiplas doses**

## Deploy (GitHub Pages)
1. Faz upload do conteúdo do ZIP para a raiz do repositório
2. Settings → Pages → Deploy from a branch → `main` / `(root)`

## Notas
- AUC24 é calculado por dose diária / CL (linear). Para perfusão contínua: AUC24 ≈ Css·24.
- Calibração por doseamento: ajusta CL com 1 ponto (limitação).
