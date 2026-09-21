/**
 * CLI 运行时状态。--json 是单次调用的输出契约，属于进程内存态，
 * 不落盘（旧版本曾把 jsonOutput 持久化到 ~/.singchorus/ctl/config.json，
 * 项目未上线，直接移除该副作用）。
 */
let jsonOutput = false;

export function setJsonOutput(v: boolean): void {
  jsonOutput = v;
}

export function isJson(): boolean {
  return jsonOutput;
}
