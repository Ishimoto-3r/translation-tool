
// Mock browser globals
global.window = {};
global.document = {
    getElementById: () => ({
        style: {},
        classList: { add: () => { }, remove: () => { } }
    }),
    querySelectorAll: () => []
};
global.alert = console.log;

const { filterAiCheckOutput, isStructuralParagraph } = require('../../manual-core.js');

describe('manual-core.js frontend logic', () => {
    describe('filterAiCheckOutput', () => {
        test('should keep normal text', () => {
            const input = "これは正常な指摘です。";
            expect(filterAiCheckOutput(input)).toBe(input);
        });

        test('should remove header/title related complaints', () => {
            const input = `
      正常な指摘。
      見出しのフォントが違います。
      タイトルの位置がおかしい。
      項目名を確認してください。
      `.trim();
            const output = filterAiCheckOutput(input);
            expect(output).toContain("正常な指摘。");
            expect(output).not.toContain("見出し");
            expect(output).not.toContain("タイトル");
            expect(output).not.toContain("項目名");
        });

        test('should remove image references like (画像1)', () => {
            const input = `
      画像1
      (画像 2)
      （画像3）
      残すべきテキスト
      `.trim();
            const output = filterAiCheckOutput(input);
            expect(output).not.toContain("画像1");
            expect(output).not.toContain("画像 2");
            expect(output).toContain("残すべきテキスト");
        });

        test('should remove spec section complaints', () => {
            const input = `
      ■仕様についてのコメント
      仕様欄の数値
      残す
      `.trim();
            const output = filterAiCheckOutput(input);
            expect(output).not.toContain("■仕様");
            expect(output).not.toContain("仕様欄");
            expect(output).toContain("残す");
        });
    });

    describe('isStructuralParagraph', () => {
        test('should identify structural lines', () => {
            // This function was exported? Let's check manual-core.js
            // Yes I exported it.
            // Implementation: checks for "■" start or "【" start etc.
            // function isStructuralParagraph(text) {
            //   return text.startsWith("■") || text.startsWith("【使用方法全文】") ...
            // }
            // Need to verify exact logic if I fail.
            // Let's assume common structural markers.
            expect(isStructuralParagraph("■使用方法")).toBe(true);
            expect(isStructuralParagraph("【使用方法全文】")).toBe(true);
            expect(isStructuralParagraph("通常のテキスト")).toBe(false);
        });
    });
});
