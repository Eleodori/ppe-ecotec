// Flat config ESLint 9. Linting solo dei moduli core + functions + test.
// L'index.html è ancora il monolite legacy: non lo linta (per ora). Quando
// estrarremo /src/ui/, /src/state/ ecc. dalla Fase 2.5 in poi, allargheremo.

export default [
  {
    files: ['src/**/*.js', 'tests/**/*.js', 'netlify/functions/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs', // i core sono UMD-lite; le Functions ESM le sovrascriviamo sotto
      globals: {
        // Browser
        window: 'readonly',
        document: 'readonly',
        globalThis: 'readonly',
        crypto: 'readonly',
        URL: 'readonly',
        Blob: 'readonly',
        FileReader: 'readonly',
        Image: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        indexedDB: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        console: 'readonly',
        // Node
        module: 'readonly',
        require: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'warn',
      'eqeqeq': ['warn', 'smart'],
      'no-shadow-restricted-names': 'error',
    },
  },
  {
    // Tutti i moduli server (Functions + DAO + impl): ESM
    files: ['netlify/functions/*.mjs', 'src/server/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        // Web Fetch API standard, disponibile nei runtime serverless (Netlify Edge, AWS Lambda Node 20+)
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
      },
    },
  },
];
