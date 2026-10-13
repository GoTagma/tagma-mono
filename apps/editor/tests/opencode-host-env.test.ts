import { expect, test } from 'bun:test';

import { buildOpencodeInheritedEnv } from '../server/opencode-host-env';

test('managed OpenCode inherits configured provider authentication and network trust', () => {
  const permitted = {
    PATH: '/configured/bin',
    DEEPSEEK_API_KEY: 'fixture-provider-credential',
    AWS_SESSION_TOKEN: 'fixture-provider-session',
    HTTP_PROXY: 'http://proxy.example.test:8080',
    https_proxy: 'http://proxy.example.test:8080',
    NO_PROXY: 'localhost,127.0.0.1',
    NODE_EXTRA_CA_CERTS: '/configured/node-ca.pem',
    SSL_CERT_FILE: '/configured/openssl-ca.pem',
    SSL_CERT_DIR: '/configured/certificates',
    CURL_CA_BUNDLE: '/configured/curl-ca.pem',
    REQUESTS_CA_BUNDLE: '/configured/requests-ca.pem',
    NPM_CONFIG_CAFILE: '/configured/npm-ca.pem',
    npm_config_cafile: '/configured/lowercase-npm-ca.pem',
  };
  expect(buildOpencodeInheritedEnv(permitted)).toEqual(permitted);
});

test('managed OpenCode does not inherit unrelated process authority or weaken TLS', () => {
  expect(
    buildOpencodeInheritedEnv({
      HOME: '/unmanaged/home',
      USERPROFILE: '/unmanaged/profile',
      XDG_DATA_HOME: '/unmanaged/data',
      OPENCODE_DB: '/unmanaged/opencode.db',
      OPENCODE_CONFIG_CONTENT: '{"plugin":["untrusted"]}',
      OPENCODE_PERMISSION: '{"*":"allow"}',
      OPENCODE_ENABLE_EXA: 'true',
      OPENCODE_SERVER_USERNAME: 'unmanaged',
      OPENCODE_SERVER_PASSWORD: 'unmanaged-password',
      TAGMA_CHAT_CONTROL_SECRET: 'control-secret',
      TAGMA_OPENCODE_DB_STATE_DIR: '/unmanaged/managed-database',
      NODE_OPTIONS: '--require untrusted-runtime-hook',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      NPM_CONFIG_STRICT_SSL: 'false',
      unrelated: 'unrelated',
      COHERE_API_KEY: undefined,
    }),
  ).toEqual({});
});

test('managed OpenCode inherits non-enumerable fixed host network keys', () => {
  const fixed = {
    HTTP_PROXY: 'http://uppercase-http.example.test',
    HTTPS_PROXY: 'http://uppercase-https.example.test',
    NO_PROXY: 'uppercase-local.example.test',
    http_proxy: 'http://lowercase-http.example.test',
    https_proxy: 'http://lowercase-https.example.test',
    no_proxy: 'lowercase-local.example.test',
    NODE_EXTRA_CA_CERTS: '/configured/node-ca.pem',
    SSL_CERT_FILE: '/configured/openssl-ca.pem',
    SSL_CERT_DIR: '/configured/certificates',
    CURL_CA_BUNDLE: '/configured/curl-ca.pem',
    REQUESTS_CA_BUNDLE: '/configured/requests-ca.pem',
    NPM_CONFIG_CAFILE: '/configured/npm-ca.pem',
    npm_config_cafile: '/configured/lowercase-npm-ca.pem',
  };
  const providerCredential = 'fixture-enumerable-provider-credential';
  const source: Record<string, string | undefined> = {
    DEEPSEEK_API_KEY: providerCredential,
  };
  for (const [key, value] of Object.entries(fixed))
    Object.defineProperty(source, key, { value, enumerable: false });

  expect(Object.keys(source)).toEqual(['DEEPSEEK_API_KEY']);
  expect(source.HTTPS_PROXY).toBe(fixed.HTTPS_PROXY);
  expect(buildOpencodeInheritedEnv(source)).toEqual({
    ...fixed,
    DEEPSEEK_API_KEY: providerCredential,
  });
});

test('managed OpenCode keeps non-enumerable private authority and inherited settings outside its host boundary', () => {
  const source = Object.create({
    HTTPS_PROXY: 'http://inherited-proxy.example.test',
    NODE_EXTRA_CA_CERTS: '/inherited/node-ca.pem',
    DEEPSEEK_API_KEY: 'fixture-inherited-provider-credential',
  }) as Record<string, string | undefined>;
  const excluded = {
    HOME: '/unmanaged/home',
    OPENCODE_DB: '/unmanaged/opencode.db',
    OPENCODE_SERVER_PASSWORD: 'fixture-private-server-password',
    TAGMA_CHAT_CONTROL_SECRET: 'fixture-private-control-token',
    NODE_OPTIONS: '--require untrusted-runtime-hook',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    NPM_CONFIG_STRICT_SSL: 'false',
    ALL_PROXY: 'http://unregistered-proxy.example.test',
    all_proxy: 'http://unregistered-lowercase-proxy.example.test',
    https_PROXY: 'http://mixed-case-proxy.example.test',
    OPENAI_API_KEY: 'fixture-non-enumerable-provider-credential',
  };
  for (const [key, value] of Object.entries(excluded))
    Object.defineProperty(source, key, { value, enumerable: false });

  expect(Object.keys(source)).toEqual([]);
  expect(Object.prototype.hasOwnProperty.call(source, 'HTTPS_PROXY')).toBe(false);
  expect(buildOpencodeInheritedEnv(source)).toEqual({});
});
