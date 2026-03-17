import { ILLMProvider } from './ILLMProvider';
import { OpenAIProvider } from './OpenAIProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { GeminiProvider } from './GeminiProvider';
import { AgentConfig } from '../types';
import { normaliseAuthMethodForProvider } from './AuthSupport';

export class ProviderFactory {
  /**
   * Create an ILLMProvider from an agent config and its resolved API key.
   * @param config  Agent configuration (provider type, model, urls, auth method).
   * @param apiKey  API key fetched from SecretStorage (may be empty for ADC auth).
   */
  static create(config: AgentConfig, apiKey: string): ILLMProvider {
    const { provider } = config;

    switch (provider.type) {
      case 'openai':
        return new OpenAIProvider({
          apiKey,
          model: provider.model,
          baseUrl: provider.base_url ?? undefined,
          proxyUrl: provider.proxy_url ?? undefined,
          providerLabel: 'openai'
        });

      case 'anthropic':
        return new AnthropicProvider({
          credential: apiKey || undefined,
          authMethod: normaliseAuthMethodForProvider('anthropic', provider.auth_method) === 'subscription' ? 'subscription' : 'api_key',
          model: provider.model,
          baseUrl: provider.base_url ?? undefined,
          proxyUrl: provider.proxy_url ?? undefined
        });

      case 'gemini':
        return new GeminiProvider({
          apiKey: apiKey || undefined,
          model: provider.model,
          authMethod: normaliseAuthMethodForProvider('gemini', provider.auth_method) as 'api_key' | 'oauth_proxy' | 'vertex_ai' | 'gcp_adc',
          baseUrl: provider.base_url ?? undefined,
          proxyUrl: provider.proxy_url ?? undefined,
          vertexLocation: provider.vertex_location ?? undefined,
          gcpProjectId: provider.gcp_project_id ?? undefined,
          vertexApiVersion: provider.vertex_api_version ?? undefined
        });

      case 'deepseek':
        // Deepseek uses an OpenAI-compatible API
        return new OpenAIProvider({
          apiKey,
          model: provider.model,
          baseUrl: provider.base_url ?? 'https://api.deepseek.com/v1',
          proxyUrl: provider.proxy_url ?? undefined,
          providerLabel: 'deepseek'
        });

      case 'qwen':
        // Qwen (Alibaba Cloud) also uses an OpenAI-compatible API
        return new OpenAIProvider({
          apiKey,
          model: provider.model,
          baseUrl: provider.base_url ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          proxyUrl: provider.proxy_url ?? undefined,
          providerLabel: 'qwen'
        });

      case 'openai_compatible': {
        if (!provider.base_url) {
          throw new Error(
            'Bormagi: "openai_compatible" provider requires a Base URL. ' +
            'Set it in Agent Settings → Provider → Base URL.'
          );
        }
        return new OpenAIProvider({
          apiKey,
          model: provider.model,
          baseUrl: provider.base_url,
          proxyUrl: provider.proxy_url ?? undefined,
          providerLabel: 'openai_compatible'
        });
      }

      default: {
        const exhaustiveCheck: never = provider.type;
        throw new Error(`Bormagi: Unknown provider type "${exhaustiveCheck}"`);
      }
    }
  }
}
