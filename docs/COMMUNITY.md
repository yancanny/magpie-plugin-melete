# Magpie community listing preparation

The proposed independent package is `magpie-plugin-melete`, maintained in this repository. It is a `page` plugin, not a provider; no `providers` entry is needed. A candidate registry entry is:

```json
{
  "package": "magpie-plugin-melete",
  "name": "Melete Magpie",
  "kind": "page",
  "summary": {
    "en": "Reflect with DSH or Codex: read the selected agent’s local history and use its configured model to create evidence-linked cards.",
    "zh": "回顾与 DSH 或 Codex 的协作：读取所选 Agent 的本机记录，经其配置的模型生成带出处的卡片。"
  }
}
```

The manifest declares no Magpie bridge reads. The plugin's local service does read selected local agent history, and the selected agent sends relevant excerpts to its configured model. No Melete-operated server receives them. See README for limits, retention and deletion. Version 0.1.1 is published on npm; the community registry pull request is pending review.

On macOS, a packaged copy passed the community `scripts/check.mjs` and was recognized as a page by `scripts/try.sh` under an isolated HOME. Node and Magpie's Bun passed the test suite with synthetic history. These checks do not establish Windows/Linux compatibility, remote Magpie compatibility, or a fresh-account real-model review. Community review remains outstanding.
