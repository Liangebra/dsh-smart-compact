import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  dts: false, // declarations via `tsc --emitDeclarationOnly`
  clean: true,
  sourcemap: true,
})
