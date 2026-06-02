/**
 * 进度提示窗口
 * 使用 Zotero 内置的 ProgressWindow 显示抓取进度
 */

export interface ProgressHandle {
  update(current: number, total: number, message: string): void;
  close(): void;
}

/**
 * 显示进度提示窗口
 * @param win 父窗口
 * @param title 进度窗口标题
 */
export function showProgress(_win: Window, title: string): ProgressHandle {
  const progressWin = new Zotero.ProgressWindow({ closeOnClick: false });
  progressWin.changeHeadline(title);
  const itemProgress = new progressWin.ItemProgress("", "初始化...");
  progressWin.show();

  return {
    update(current: number, total: number, message: string) {
      itemProgress.setText(message);
      if (total > 0) {
        itemProgress.setProgress((current / total) * 100);
      }
    },
    close() {
      progressWin.close();
    },
  };
}
