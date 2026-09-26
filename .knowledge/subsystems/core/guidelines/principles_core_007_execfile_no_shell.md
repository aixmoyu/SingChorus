---
project: SingChorus
type: development-principle
id: principle-core-007
description: 一切外部命令经 execFile 参数数组调用，不经 shell；镜像名、路径等外部输入永不进入字符串拼接的命令行。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 工程
---

# 子进程最小暴露：execFile 无 shell

## 原则详细描述

docker/sing-box 全部命令以 `execFile(cmd, args数组, {timeout})` 执行：validator 的 `docker pull`、`docker info`、`docker run --rm -v <tmpFile>:/etc/sing-box/config.json <image> check -c ...`（validator.ts:28-40,80-89,152-158），docker-manager 的 compose 系列（docker-manager.ts:36-48,132-139）。每类调用都有显式超时（校验 validate_timeout、compose 60s、info/chmod 5s）。

## 为什么要这样

「execFile 传参不经过 shell，镜像名/路径中的特殊字符不会构成注入面」（validator.ts:152 注释，core-R1）。镜像名可被用户配置（singbox_image），路径含临时 UUID；一旦经 shell 拼接即成命令注入点。超时兜底防容器/CLI 挂死拖垮调用方。

## 适用范围

- validator.ts、docker-manager.ts 全部子进程调用；未来任何新外部命令。

## 规则

- 参数一律数组元素，含空格/特殊字符的路径、镜像引用不作字符串拼接。
- 每次调用必须带 timeout；错误对象附加 stdout/stderr 供上层日志（两处 execFileAsync 均实现，validator.ts:30-39）。
- 容器内挂载路径固定，宿主侧临时文件用后清理（validator.ts:145-166）。

## 反模式 / 禁止项

- `exec(cmd字符串)` / 模板字符串拼命令行。
- 无超时的子进程调用。
- 把用户输入直接作为命令第一个词（可执行名）。

## 修改检查清单

- [ ] 新命令用 execFile + 参数数组
- [ ] timeout 已设置且与操作时长匹配
- [ ] 失败路径携带 stderr 进日志/错误消息
