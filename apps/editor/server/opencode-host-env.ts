const OPENCODE_HOST_ENV_KEYS = new Set([
  'PATH',
  'Path',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'SHELL',
  'LANG',
  'LC_ALL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'NPM_CONFIG_CAFILE',
  'npm_config_cafile',
]);

export const OPENCODE_PROVIDER_ENV_PREFIXES = [
  'OPENAI_',
  'ANTHROPIC_',
  'GEMINI_',
  'GOOGLE_',
  'OPENROUTER_',
  'GROQ_',
  'AZURE_OPENAI_',
  'AWS_',
  'XAI_',
  'MISTRAL_',
  'DEEPSEEK_',
  'COHERE_',
] as const;

/**
 * Host provider authentication, proxy routing, and CA trust shared by every
 * managed OpenCode entry point. Workspace isolation and server/control authority
 * are applied separately; ordinary command tasks do not inherit this allowlist.
 */
export function buildOpencodeInheritedEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      typeof value === 'string' &&
      (OPENCODE_HOST_ENV_KEYS.has(key) ||
        OPENCODE_PROVIDER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))
    ) {
      env[key] = value;
    }
  }
  return env;
}
