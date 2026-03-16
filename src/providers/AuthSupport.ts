import type { AuthMethod, ProviderType } from '../types';

export function providerSupportsSubscription(providerType: ProviderType): boolean {
  return providerType === 'anthropic';
}

export function authMethodRequiresCredential(authMethod: AuthMethod): boolean {
  return authMethod === 'api_key' || authMethod === 'subscription';
}

export function normaliseAuthMethodForProvider(providerType: ProviderType, authMethod: AuthMethod): AuthMethod {
  if (providerType === 'gemini') {
    const normalized = authMethod === 'gcp_adc' ? 'vertex_ai' : authMethod;
    return (normalized === 'api_key' || normalized === 'oauth_proxy' || normalized === 'vertex_ai')
      ? normalized
      : 'api_key';
  }

  if (providerType === 'anthropic') {
    return authMethod === 'subscription' ? 'subscription' : 'api_key';
  }

  return 'api_key';
}
