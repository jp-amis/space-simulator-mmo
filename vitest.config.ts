import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Collect tests from every workspace package.
    include: ["{apps,packages,tools}/*/src/**/*.{test,spec}.ts"],
    passWithNoTests: true,
  },
});
