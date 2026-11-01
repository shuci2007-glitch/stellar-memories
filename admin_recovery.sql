-- ============================================================
-- 星辰相册 · 账号找回操作手册（人工核对 + 自助迁移）
--
-- 两种方式二选一：
--   A. 自助迁移：用户用新号登录 → 页面右上角「找回旧数据」→ 输入旧恢复码 →
--      自动执行 recover_by_code()，把旧账号的 albums/media/families/family_members
--      归到当前账号。管理员无需介入，也无需跑 SQL。
--   B. 人工核对：用户把恢复码发给你 → 你按本文件核对并手动执行迁移。
--
-- 恢复码哈希规则（重要）：
--   取恢复码去掉所有横线/空格、转大写后的 20 位十六进制，再算 sha256。
--   例：显示 A1B2-C3D4-E5F6-7890-ABCD
--       规范化 = A1B2C3D4E5F67890ABCD
--       sha256 = printf '%s' 'A1B2C3D4E5F67890ABCD' | sha256sum
-- ============================================================


-- ------------------------------------------------------------
-- 第 0 步：核对身份（人工迁移必做）
-- 把上面算出的 64 位十六进制填到 '<SHA256_HEX>'：
-- ------------------------------------------------------------
SELECT owner_id, display_name, phone, email, wechat_id
FROM profiles
WHERE recovery_code_hash = '<SHA256_HEX>';
-- 返回一行 = 是该账号主人，可继续；为空 = 恢复码不对，拒绝。


-- ------------------------------------------------------------
-- 第 1 步：定位新旧账号
--   · 按手机号： SELECT owner_id FROM profiles WHERE phone = '13800000000';
--   · 按邮箱：   SELECT owner_id FROM profiles WHERE email = 'a@b.com';
--   · 按微信：   SELECT owner_id FROM profiles WHERE wechat_id = '<openid>';
--   · 旧账号 uid = OLD，新账号（用户先用新号登录一次）uid = NEW。
-- ------------------------------------------------------------
SELECT owner_id, display_name, phone, email, wechat_id
FROM profiles WHERE owner_id IN ('OLD', 'NEW');


-- ------------------------------------------------------------
-- 第 2 步：迁移 profile
-- 若新账号已有 profile，先删（避免 UNIQUE(owner_id) 冲突），再把旧 profile 挪过去。
-- 注意：这一步会把旧的加密密码/设备绑定一并带过去。
-- 如果用户不记得旧加密密码，改用：
--   DELETE FROM profiles WHERE owner_id='NEW';
--   UPDATE profiles SET owner_id='NEW' WHERE owner_id='OLD';
--   UPDATE profiles SET encryption_password_set=false, encryption_password_hash=NULL, device_id=NULL
--     WHERE owner_id='NEW';
-- ------------------------------------------------------------
DELETE FROM profiles WHERE owner_id = 'NEW';
UPDATE profiles SET owner_id = 'NEW' WHERE owner_id = 'OLD';


-- ------------------------------------------------------------
-- 第 3 步：迁移业务数据归属
-- ------------------------------------------------------------
UPDATE albums         SET owner_id = 'NEW' WHERE owner_id = 'OLD';
UPDATE media          SET owner_id = 'NEW' WHERE owner_id = 'OLD';
UPDATE families       SET owner_id = 'NEW' WHERE owner_id = 'OLD';
UPDATE family_members SET user_id  = 'NEW' WHERE user_id  = 'OLD';


-- ------------------------------------------------------------
-- 第 4 步：验证
-- ------------------------------------------------------------
SELECT 'albums' AS t, count(*) FROM albums   WHERE owner_id = 'NEW'
UNION ALL
SELECT 'media', count(*) FROM media          WHERE owner_id = 'NEW'
UNION ALL
SELECT 'families', count(*) FROM families    WHERE owner_id = 'NEW'
UNION ALL
SELECT 'family_members', count(*) FROM family_members WHERE user_id = 'NEW';


-- ------------------------------------------------------------
-- 第 5 步（可选）：迁移「删除区」数据
-- 用户要求恢复已软删除/已彻底删除的照片或相册时，在核对恢复码通过后执行。
-- 注意：自助迁移 recover_by_code 只搬「未删除区」(deleted_at IS NULL)，
--       删除区必须由管理员手动执行下面两条。
-- ------------------------------------------------------------
UPDATE albums SET owner_id = 'NEW' WHERE owner_id = 'OLD' AND deleted_at IS NOT NULL;
UPDATE media  SET owner_id = 'NEW' WHERE owner_id = 'OLD' AND deleted_at IS NOT NULL;


-- ------------------------------------------------------------
-- 注意事项
-- 1) 自助迁移函数 recover_by_code(p_code_hash) 已在云端创建：
--      · 入参是「规范化恢复码的 sha256 十六进制」；
--      · 只迁移 albums/media/families/family_members；
--      · 迁移后清空旧 profile 的 recovery_code_hash，并把该码写到新 profile（码仍有效）。
-- 2) 媒体文件物理路径仍为 users/<旧uid>/...；数据库归属变了，但能否读取还取决于
--    云存储策略。若新账号看不到图片，需要进一步做「文件复制到新 uid 路径」。
-- 3) 建议每次迁移先核对恢复码，别跳过第 0 步，防冒领。
-- 4) 以后做管理台时，可把本流程封装成一键操作。
-- ============================================================
