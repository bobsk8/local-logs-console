import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: ['out/**', 'media/**', 'node_modules/**', '*.vsix', 'esbuild.mjs', 'test/**']
    },
    ...tseslint.configs.recommended,
    {
        // Extension host: Node context — no DOM globals allowed.
        files: ['src/**/*.ts'],
        ignores: ['src/webview-src/**'],
        rules: {
            'no-restricted-globals': ['error', 'document', 'window', 'navigator', 'localStorage'],
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'warn',
            'eqeqeq': ['error', 'smart'],
            'no-empty': ['error', { allowEmptyCatch: true }]
        }
    },
    {
        // Webview: browser context.
        files: ['src/webview-src/**/*.ts'],
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'warn',
            'eqeqeq': ['error', 'smart'],
            'no-empty': ['error', { allowEmptyCatch: true }]
        }
    }
);
