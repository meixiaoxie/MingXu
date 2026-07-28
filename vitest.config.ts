import { defineConfig } from "vitest/config";

// 测试只在 Node.js 环境运行，匹配项目中的 TypeScript 测试文件。
// 不允许“没有测试也通过”，避免测试被误删后 CI 仍显示成功。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/package-smoke.test.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
