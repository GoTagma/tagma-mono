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
