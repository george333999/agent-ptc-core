# Pull Request 模板

## 改动说明

## 动机与范围

## 验证方式

- [ ] `npm test` 通过
- [ ] 涉及示例时，`npm run example:minimal` 或 `npm run example:ptc` 通过
- [ ] 涉及基准时，`npm run benchmark:report` 可生成完整报告
- [ ] 新增行为有对应测试

## 对缓存前缀的影响

- [ ] 不影响前缀字节
- [ ] 会影响前缀，已在描述中说明原因和验证结果
- [ ] 不确定

## 安全边界

- [ ] 没有新增网络、写文件或 shell 能力到 PTC 沙盒
- [ ] 工具结果脱敏、路径约束和失败回退仍然成立
- [ ] 没有提交密钥、个人路径或未脱敏数据

## 关联 issue

Closes #
