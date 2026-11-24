export const WEB_KEY_ENV = {
  brave: "BRAVE_API_KEY",
  context: "CONTEXT_DEV_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  exa: "EXA_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
  parallel: "PARALLEL_API_KEY",
  tavily: "TAVILY_API_KEY",
  tinyfish: "TINYFISH_API_KEY",
} as const;

export type RemoteWebProvider = keyof typeof WEB_KEY_ENV;
export const WEB_SEARCH_PROVIDERS = Object.keys(
  WEB_KEY_ENV,
) as RemoteWebProvider[];
export const WEB_EXTRACT_PROVIDERS = [
  "local",
  "context",
  "deepseek",
  "exa",
  "firecrawl",
  "parallel",
  "tavily",
  "tinyfish",
] as const;

export type WebProvider = RemoteWebProvider | "local";
export type WebConfig = {
  search: readonly RemoteWebProvider[];
  extract: readonly (typeof WEB_EXTRACT_PROVIDERS)[number][];
  weather?: boolean;
};

export const WEB_PROVIDER_LABELS: Record<WebProvider, string> = {
  brave: "Brave",
  context: "Context",
  deepseek: "DeepSeek",
  exa: "Exa",
  firecrawl: "Firecrawl",
  parallel: "Parallel",
  tavily: "Tavily",
  tinyfish: "TinyFish",
  local: "Local",
};

export const WEB_CHOICES = {
  search: WEB_SEARCH_PROVIDERS,
  extract: WEB_EXTRACT_PROVIDERS,
};
