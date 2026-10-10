CREATE TABLE mx_device.task_definitions (
 id text PRIMARY KEY, mode text NOT NULL CHECK(mode='sim'), code text NOT NULL,
 version integer NOT NULL CHECK(version>0), document jsonb NOT NULL, UNIQUE(mode,code,version)
);
CREATE TABLE mx_device.loop_policies (
 id uuid PRIMARY KEY, mode text NOT NULL CHECK(mode='sim'), rack text NOT NULL,
 document jsonb NOT NULL, UNIQUE(mode,rack)
);
CREATE TABLE mx_device.execution_commands (
 id uuid PRIMARY KEY, mode text NOT NULL CHECK(mode='sim'),
 job_id uuid NOT NULL REFERENCES mx_device.jobs(id),
 attempt_id uuid NOT NULL REFERENCES mx_device.attempts(id),
 device_id uuid NOT NULL REFERENCES mx_device.devices(id),
 status text NOT NULL, created_at bigint NOT NULL, document jsonb NOT NULL
);
CREATE UNIQUE INDEX command_one_running_per_device ON mx_device.execution_commands(device_id) WHERE status='running';
CREATE INDEX command_job_history ON mx_device.execution_commands(job_id,created_at);
CREATE INDEX command_attempt_history ON mx_device.execution_commands(attempt_id);
CREATE INDEX command_recent_history ON mx_device.execution_commands(mode,created_at DESC);
CREATE UNIQUE INDEX job_one_live_session ON mx_device.attempts(job_id) WHERE status IN ('running','yielded');
CREATE UNIQUE INDEX device_one_large_session ON mx_device.attempts(device_id) WHERE status IN ('running','yielded') AND document->>'loop'='large';
CREATE UNIQUE INDEX device_rack_slot ON mx_device.devices(mode,(document->>'rack'),(document->>'slot')) WHERE document ? 'slot';

INSERT INTO mx_device.task_definitions VALUES ('sim:weibo.list:1','sim','weibo.list',1,'{"id":"sim:weibo.list:1","mode":"sim","code":"weibo.list","name":"微博 · 浏览列表","appId":"weibo","loop":"small","steps":[{"code":"app.open","repeat":1},{"code":"weibo.list","repeat":1}],"resumable":false,"version":1,"createdAt":0,"executionModel":"checkpoint-session.v1"}'::jsonb);
INSERT INTO mx_device.task_definitions VALUES ('sim:weibo.search:1','sim','weibo.search',1,'{"id":"sim:weibo.search:1","mode":"sim","code":"weibo.search","name":"微博 · 搜索","appId":"weibo","loop":"small","steps":[{"code":"app.open","repeat":1},{"code":"weibo.search","repeat":1}],"resumable":false,"version":1,"createdAt":0,"executionModel":"checkpoint-session.v1"}'::jsonb);
INSERT INTO mx_device.task_definitions VALUES ('sim:weibo.like:1','sim','weibo.like',1,'{"id":"sim:weibo.like:1","mode":"sim","code":"weibo.like","name":"微博 · 点赞（模拟）","appId":"weibo","loop":"small","steps":[{"code":"app.open","repeat":1},{"code":"weibo.like","repeat":1}],"resumable":false,"version":1,"createdAt":0,"executionModel":"checkpoint-session.v1"}'::jsonb);
INSERT INTO mx_device.task_definitions VALUES ('sim:xhs.list:1','sim','xhs.list',1,'{"id":"sim:xhs.list:1","mode":"sim","code":"xhs.list","name":"小红书 · 浏览列表","appId":"xhs","loop":"small","steps":[{"code":"app.open","repeat":1},{"code":"xhs.list","repeat":1}],"resumable":false,"version":1,"createdAt":0,"executionModel":"checkpoint-session.v1"}'::jsonb);
INSERT INTO mx_device.task_definitions VALUES ('sim:xhs.detail:1','sim','xhs.detail',1,'{"id":"sim:xhs.detail:1","mode":"sim","code":"xhs.detail","name":"小红书 · 详情","appId":"xhs","loop":"small","steps":[{"code":"app.open","repeat":1},{"code":"xhs.note.detail","repeat":1}],"resumable":false,"version":1,"createdAt":0,"executionModel":"checkpoint-session.v1"}'::jsonb);
INSERT INTO mx_device.task_definitions VALUES ('sim:xhs.ocr:1','sim','xhs.ocr',1,'{"id":"sim:xhs.ocr:1","mode":"sim","code":"xhs.ocr","name":"小红书 · get_note_detail（OCR）","appId":"xhs","loop":"small","steps":[{"code":"app.open","repeat":1},{"code":"xhs.get_note_detail.ocr","repeat":1}],"resumable":false,"version":1,"createdAt":0,"executionModel":"checkpoint-session.v1"}'::jsonb);
INSERT INTO mx_device.task_definitions VALUES ('sim:xhs.search10:1','sim','xhs.search10',1,'{"id":"sim:xhs.search10:1","mode":"sim","code":"xhs.search10","name":"小红书 · 搜索第 1–10 页","appId":"xhs","loop":"large","steps":[{"code":"app.open","repeat":1},{"code":"xhs.search","repeat":1},{"code":"xhs.search.next","repeat":9},{"code":"session.home","repeat":1}],"resumable":true,"version":1,"createdAt":0,"executionModel":"checkpoint-session.v1"}'::jsonb);
INSERT INTO mx_device.task_definitions VALUES ('sim:weibo.search_batch:1','sim','weibo.search_batch',1,'{"id":"sim:weibo.search_batch:1","mode":"sim","code":"weibo.search_batch","name":"微博 · 连续搜索 5 次","appId":"weibo","loop":"large","steps":[{"code":"app.open","repeat":1},{"code":"weibo.search","repeat":5},{"code":"session.home","repeat":1}],"resumable":true,"version":1,"createdAt":0,"executionModel":"checkpoint-session.v1"}'::jsonb);
