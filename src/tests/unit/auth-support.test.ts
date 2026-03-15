import { authMethodRequiresCredential, normaliseAuthMethodForProvider, providerSupportsSubscription } from '../../providers/AuthSupport';

describe('AuthSupport', () => {
  test('subscription support is enabled only for anthropic', () => {
    expect(providerSupportsSubscription('anthropic')).toBe(true);
    expect(providerSupportsSubscription('openai')).toBe(false);
  });

  test('authMethodRequiresCredential returns true for api_key and subscription', () => {
    expect(authMethodRequiresCredential('api_key')).toBe(true);
    expect(authMethodRequiresCredential('subscription')).toBe(true);
    expect(authMethodRequiresCredential('oauth_proxy')).toBe(false);
  });

  test('normaliseAuthMethodForProvider constrains invalid combos', () => {
    expect(normaliseAuthMethodForProvider('gemini', 'subscription')).toBe('api_key');
    expect(normaliseAuthMethodForProvider('anthropic', 'subscription')).toBe('subscription');
    expect(normaliseAuthMethodForProvider('openai', 'oauth_proxy')).toBe('api_key');
  });
});
