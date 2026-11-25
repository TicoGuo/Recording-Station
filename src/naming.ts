// 录制文件命名通用逻辑（iOS / Android 共用）。
// 平台前缀（iOS_ / Android_）由各平台自己的录制模块拼接，这里只负责通用的日期部分。

// 本地日期戳：YYYY_MM_DD（用系统本地时区，避免 UTC 导致日期差一天）
export function localDateStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}_${m}_${day}`;
}
