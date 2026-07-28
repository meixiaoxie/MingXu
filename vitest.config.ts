import { defineConfig } from "vitest/config";

// 测试只在 Node.js 环境运行，匹配项目中的 TypeScript 测试文件。
// 脚手架阶段允许暂时没有测试，后续新增测试后仍会正常执行。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    passWithNoTests: true,
    clearMocks: true,
    restoreMocks: true,
  },
});
