import { defineConfig } from 'vite';

// 상대 경로로 빌드 → GitHub Pages 저장소 이름(/repo-name/)과 상관없이 동작
export default defineConfig({
  base: './',
});
