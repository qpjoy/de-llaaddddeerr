# 企业数据接口返回字段附录（2026-11-10）

由 Hub 固定接口目录 `server/external-platforms/qixin-catalog.json`（启信慧眼目录快照 2026-09-01，价格与新增接口 2026-09-17）逐接口生成。字段名、类型、是否声明必返和含义都照抄目录，Hub 不校验、不转换响应字段。说明见 [enterprise-data-response-fields-2026-11-10.md](enterprise-data-response-fields-2026-11-10.md)。

- 字段路径相对于 Hub 响应体的 `data`（下游示例代码里的 `result.data`）。例如这里的 `data.items[].name` 在 Hub 响应里是 `result.data.data.items[].name`。
- `[]` 表示上一级在目录里声明为 Array。
- “URL” 列标 🔗 的字段，是主文档 URL 清单收录的链接类字段。
- 22.11 等接口按入参 `kind` 返回不同字段组，目录把各组平铺在同一个 `data` 下，以 `type` 行分隔。这里保留原样。

外层字段（每个接口都一样，由 Hub 代码生成，不在下表中）：`contractVersion`、`apiId`、`requestId`、`data`、`meta.capturedAt`、`meta.resultState`、`meta.servedAt`、`meta.sourceMode`、`meta.ageSeconds`、`meta.reason`、`meta.fallbackReason`（仅回退时）。


## 业务场景


### 47.51 客户信息尽调

- Hub：`POST /api/v1/data/enterprise/47.51/query`；上游方法 GET（可选 GET/POST）；可调用
- 说明：企业信息全面排查，通过企业名称/统代一键获取企业工商信息、集团信息、企业标签、上市信息、经营等企业画像信息。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `dimension` | String | 否 | 返回内容。默认返回所有，如果输入序号，则输出基础信息（ent_info,group_info,district_info,industry_info,tags_list）加上所输入序号对应的内容。多个序号用英文逗号连接，如3,4,5。所有序号映射参考附件“47.51入参dimension映射关系表” |
| `is_history` | String | 否 | 是否查询历史数据，默认为0。枚举：0 查询当前最新数据，1 查询历史数据 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.ent_info` | Object | 是 | 企业基本信息 |  |
| `data.ent_info.eid` | String | 是 | 企业唯一标识id |  |
| `data.ent_info.credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.ent_info.name` | String | 是 | 企业名称 |  |
| `data.ent_info.oper_name` | String | 是 | 法定代表人 |  |
| `data.ent_info.title` | String | 是 | 公司代表人职务 |  |
| `data.ent_info.status` | String | 是 | 登记状态 |  |
| `data.ent_info.start_date` | String | 是 | 成立日期，yyyy-mm-dd |  |
| `data.ent_info.regist_capi` | String | 是 | 注册资本 |  |
| `data.ent_info.actual_capi` | String | 是 | 实缴资本 |  |
| `data.ent_info.org_no` | String | 是 | 组织机构代码 |  |
| `data.ent_info.reg_no` | String | 是 | 工商注册号 |  |
| `data.ent_info.tax_num` | String | 是 | 纳税人识别号 |  |
| `data.ent_info.econ_kind` | String | 是 | 企业类型 |  |
| `data.ent_info.organization_code` | String | 是 | 组织分类代码，1560101：机关; 1560102：事业单位; 1560103：中央编办直接管理机构编制的群众团体 ;1560201：律师执业机构; 1560202：公证处; 1560203：基层法律服务所; 1560204：司法鉴定机构;1560205：仲裁委员会; 1560301：社会团体; 1560302：民办非企业单位; 1560303：基金会; 1560304：村民委员会; 1560305：居民委员会; 1560401：基层工会; 1560501：企业; 1560502：个体工商户; 1560503：农民专业合作社; 1560601：组级集体经济组织; 1560602：村级集体经济组织; 1560603：乡镇级集体经济组织; 1569999：其他; 3440101：香港; 4660101：澳门; 1580101：台湾 |  |
| `data.ent_info.term_start` | String | 是 | 开始营业期限，yyyy-mm-dd |  |
| `data.ent_info.term_end` | String | 是 | 结束营业期限，yyyy-mm-dd |  |
| `data.ent_info.qualification` | String | 是 | 纳税人资质 |  |
| `data.ent_info.collegues_num` | String | 是 | 人员规模 |  |
| `data.ent_info.canbao_count` | String | 是 | 参保人数 |  |
| `data.ent_info.check_date` | String | 是 | 核准日期，yyyy-mm-dd |  |
| `data.ent_info.belong_org` | String | 是 | 登记机关 |  |
| `data.ent_info.import_export_num` | String | 是 | 进出口企业代码 |  |
| `data.ent_info.fenname` | String | 是 | 英文名 |  |
| `data.ent_info.address` | String | 是 | 注册地址 |  |
| `data.ent_info.scope` | String | 是 | 经营范围 |  |
| `data.ent_info.brief` | String | 是 | 简介 |  |
| `data.ent_info.logo_url` | String | 是 | logo地址 | 🔗 |
| `data.ent_info.is_small` | String | 是 | 是否为小微企业库企业，1:是，0:不是 |  |
| `data.ent_info.scale` | String | 是 | 企业规模 |  |
| `data.ent_info.is_history` | String | 是 | 工商是否下架 |  |
| `data.ent_info.is_listed` | String | 是 | 是否上市，(0:未上市，1:上市) |  |
| `data.group_info` | Object | 是 | 所属集团 |  |
| `data.group_info.group_name` | String | 是 | 所属集团 |  |
| `data.group_info.group_eid` | String | 是 | 集团eid |  |
| `data.group_info.group_logo` | String | 是 | 集团logo | 🔗 |
| `data.district_info` | Object | 是 | 区域信息 |  |
| `data.district_info.province` | String | 是 | 省份 |  |
| `data.district_info.city` | String | 是 | 城市 |  |
| `data.district_info.district` | String | 是 | 区县 |  |
| `data.district_info.district_code` | String | 是 | 所属区域代码 |  |
| `data.industry_info` | Object | 是 | 行业信息 |  |
| `data.industry_info.indu_code_l1` | String | 是 | 一级行业代码 |  |
| `data.industry_info.indu_l1` | String | 是 | 一级行业描述 |  |
| `data.industry_info.indu_code_l2` | String | 是 | 二级行业代码 |  |
| `data.industry_info.indu_l2` | String | 是 | 二级行业描述 |  |
| `data.industry_info.indu_code_l3` | String | 是 | 三级行业代码 |  |
| `data.industry_info.indu_l3` | String | 是 | 三级行业描述 |  |
| `data.industry_info.indu_code_l4` | String | 是 | 四级行业代码 |  |
| `data.industry_info.indu_l4` | String | 是 | 四级行业描述 |  |
| `data.tags_list` | Array | 是 | 企业画像 |  |
| `data.tags_list[].tag_id` | String | 是 | 标签id |  |
| `data.tags_list[].tag_name` | String | 是 | 标签名称 |  |
| `data.contract_info` | Object | 是 | 联系方式 |  |
| `data.contract_info.addresses_list` | Array | 是 | 全部地址 |  |
| `data.contract_info.addresses_list[].address` | String | 是 | 地址 |  |
| `data.contract_info.addresses_list[].source` | String | 是 | 地址来源 |  |
| `data.contract_info.addresses_list[].date` | String | 是 | 获取日期 |  |
| `data.contract_info.telephones_list` | Array | 是 | 全部电话 |  |
| `data.contract_info.telephones_list[].telephone` | String | 是 | 电话 |  |
| `data.contract_info.telephones_list[].date` | String | 是 | 获取日期 |  |
| `data.contract_info.telephones_list[].source` | String | 是 | 电话来源 |  |
| `data.contract_info.websites_list` | Array | 是 | 全部网址 |  |
| `data.contract_info.websites_list[].web_url` | String | 是 | 网址 | 🔗 |
| `data.contract_info.websites_list[].date` | String | 是 | 获取日期 |  |
| `data.contract_info.websites_list[].source` | String | 是 | 网址来源 |  |
| `data.contract_info.emails_list` | Array | 是 | 全部邮箱 |  |
| `data.contract_info.emails_list[].email` | String | 是 | 邮箱 |  |
| `data.contract_info.emails_list[].date` | String | 是 | 获取日期 |  |
| `data.contract_info.emails_list[].source` | String | 是 | 邮箱来源 |  |
| `data.employees_list` | Array | 是 | 主要人员信息 |  |
| `data.employees_list[].name` | String | 是 | 姓名 |  |
| `data.employees_list[].title` | String | 是 | 职位 |  |
| `data.partners_list` | Array | 是 | 股东信息(工商登记股东） |  |
| `data.partners_list[].stock_name` | String | 是 | 股东名称 |  |
| `data.partners_list[].stock_id` | String | 是 | 股东id |  |
| `data.partners_list[].credit_no` | String | 是 | 股东credit_no |  |
| `data.partners_list[].stock_type` | String | 是 | 股东类型 |  |
| `data.partners_list[].stock_percent` | String | 是 | 持股比例 |  |
| `data.partners_list[].country` | String | 是 | 国家,地区 |  |
| `data.partners_list[].total_should_capi` | String | 是 | 认缴出资 |  |
| `data.partners_list[].total_real_capi` | String | 是 | 实缴出资 |  |
| `data.partners_list[].start_date` | String | 是 | 开始参股日期 |  |
| `data.pub_partners_list` | Array | 是 | 股东信息(最新公示股东） |  |
| `data.pub_partners_list[].stock_name` | String | 是 | 股东名称 |  |
| `data.pub_partners_list[].stock_id` | String | 是 | 股东id |  |
| `data.pub_partners_list[].share_type` | String | 是 | 股份类型 |  |
| `data.pub_partners_list[].stock_type` | String | 是 | 股东类型 |  |
| `data.pub_partners_list[].stock_percent` | String | 是 | 持股比例 |  |
| `data.pub_partners_list[].should_capi` | String | 是 | 认缴额（万） |  |
| `data.pub_partners_list[].con_date` | String | 是 | 认缴出资日期 |  |
| `data.pub_partners_list[].real_capi` | String | 是 | 实缴额（万） |  |
| `data.pub_partners_list[].real_capi_date` | String | 是 | 实缴出资日期 |  |
| `data.pub_partners_list[].currency_code` | String | 是 | 币种代码 |  |
| `data.pub_partners_list[].country` | String | 是 | 股东国别 |  |
| `data.pub_partners_list[].stock_num` | String | 是 | 持股数，一般是上市公司返回 |  |
| `data.invest_list` | Array | 是 | 对外投资信息 |  |
| `data.invest_list[].invest_name` | String | 是 | 被投资企业名称 |  |
| `data.invest_list[].invest_status` | String | 是 | 被投资企业状态 |  |
| `data.invest_list[].invest_eid` | String | 是 | 被投资公司id |  |
| `data.invest_list[].invest_oper_name` | String | 是 | 被投资企业法定代表人 |  |
| `data.invest_list[].invest_regist_capi` | String | 是 | 被投资企业注册资本 |  |
| `data.invest_list[].stock_num` | String | 是 | 认缴出资额/持股数 |  |
| `data.invest_list[].stock_percent` | String | 是 | 投资比例 |  |
| `data.invest_list[].invest_start_date` | String | 是 | 被投资企业成立日期 |  |
| `data.invest_list[].invest_credit_no` | String | 是 | 被投资公司统一社会信用代码 |  |
| `data.invest_list[].invest_reg_no` | String | 是 | 被投资公司注册号 |  |
| `data.invest_list[].belong_org` | String | 是 | 被投资公司登记机关 |  |
| `data.invest_list[].invest_quote_status` | String | 是 | 被投资公司上市状态 |  |
| `data.invest_list[].should_con_date` | String | 是 | 认缴缴出资日期 |  |
| `data.invest_list[].currency_code` | String | 是 | 货币代码，认缴和实缴都是用这个货币代码 |  |
| `data.invest_list[].real_capi` | String | 是 | 实缴额 |  |
| `data.invest_list[].should_capi` | String | 是 | 认缴额 |  |
| `data.change_record_list` | Array | 是 | 变更记录 |  |
| `data.change_record_list[].change_date` | String | 是 | 变更日期 |  |
| `data.change_record_list[].change_item` | String | 是 | 变更名称 |  |
| `data.change_record_list[].type` | String | 是 | 变更分类 |  |
| `data.change_record_list[].before_content` | String | 是 | 变更前 |  |
| `data.change_record_list[].after_content` | String | 是 | 变更后 |  |
| `data.branches_list` | Array | 是 | 分支机构 |  |
| `data.branches_list[].name` | String | 是 | 企业名称 |  |
| `data.branches_list[].sub_eid` | String | 是 | 分支机构eid |  |
| `data.branches_list[].oper_name` | String | 是 | 负责人/法人代表 |  |
| `data.branches_list[].status` | String | 是 | 状态 |  |
| `data.branches_list[].district_code` | String | 是 | 所在地区 |  |
| `data.branches_list[].start_date` | String | 是 | 成立日期 |  |
| `data.actual_controller_info` | Object | 是 | 实际控制人 |  |
| `data.actual_controller_info.entity_name` | String | 是 | 实控人名称 |  |
| `data.actual_controller_info.entity_eid` | String | 是 | 实际控制人id |  |
| `data.actual_controller_info.total_percent` | String | 是 | 实控人总持股 |  |
| `data.actual_controller_info.path` | Object | 是 | 实控人关系路径 |  |
| `data.actual_controller_info.path.nodes` | Array | 是 | 节点 |  |
| `data.actual_controller_info.path.nodes[].eid` | String | 是 | eid或pid |  |
| `data.actual_controller_info.path.nodes[].name` | String | 是 | 名称 |  |
| `data.actual_controller_info.path.nodes[].label` | String | 是 | 节点标签(P个人 E企业 U其他 UE未在工商注册的企业或组织) |  |
| `data.actual_controller_info.path.nodes[].iskey` | String | 是 | 是否为起始或终止节点标识 |  |
| `data.actual_controller_info.path.links` | Array | 是 | 路径 |  |
| `data.actual_controller_info.path.links[].sourceId` | String | 是 | 路径起始节点 |  |
| `data.actual_controller_info.path.links[].targetId` | String | 是 | 路径末尾节点 |  |
| `data.actual_controller_info.path.links[].percent` | String | 是 | 股比 |  |
| `data.actual_controller_info.path.links[].isMainPath` | String | 是 | 是否为主路径, 1-是, 0-否 |  |
| `data.actual_controller_info.path.links[].lrDescDetai` | String | 是 | 执行事务合伙人描述标注 |  |
| `data.benefit_list` | Array | 是 | 受益所有人 |  |
| `data.benefit_list[].entity_name` | String | 是 | 受益所有人名称 |  |
| `data.benefit_list[].entity_eid` | String | 是 | 受益人id |  |
| `data.benefit_list[].total_percent` | String | 是 | 投资比例 |  |
| `data.benefit_list[].entity_type` | String | 是 | 受益所有人类型，P个人 E企业 U其他 UE未在工商注册的企业或组织 |  |
| `data.benefit_list[].path` | String | 是 | 持股路径 |  |
| `data.benefit_list[].path.nodes` | Array | 是 | 节点 |  |
| `data.benefit_list[].path.nodes[].uid` | String | 是 | uid |  |
| `data.benefit_list[].path.nodes[].name` | String | 是 | 名称 |  |
| `data.benefit_list[].path.nodes[].label` | String | 是 | 节点标签(P个人 E企业 U其他 UE未在工商注册的企业或组织) |  |
| `data.benefit_list[].path.nodes[].key` | String | 是 | 是否为起始或终止节点标识 |  |
| `data.benefit_list[].path.links` | Array | 是 | 路径 |  |
| `data.benefit_list[].path.links[].sourceId` | String | 是 | 路径起始节点 |  |
| `data.benefit_list[].path.links[].targetId` | String | 是 | 路径末尾节点 |  |
| `data.benefit_list[].path.links[].type` | String | 是 | 类型 |  |
| `data.benefit_list[].path.links[].percent` | String | 是 | 比例 |  |
| `data.benefit_list[].type` | String | 是 | 判定理由 |  |
| `data.history_name_list` | Array | 是 | 历史名称 |  |
| `data.history_name_list[].history_name` | String | 是 | 历史公司名/曾用名 |  |
| `data.history_name_list[].eid` | String | 是 | 企业eid |  |
| `data.history_name_list[].date` | String | 是 | 变更时间 |  |
| `data.logout_info` | Object | 是 | 注销吊销信息 |  |
| `data.logout_info.logout_reason` | String | 是 | 注销原因 |  |
| `data.logout_info.logout_date` | String | 是 | 注销日期 |  |
| `data.logout_info.revoke_reason` | String | 是 | 吊销原因 |  |
| `data.logout_info.revoke_date` | String | 是 | 吊销日期 |  |
| `data.listed_info` | Object | 是 | 上市信息 |  |
| `data.listed_info.listed_type` | String | 是 | 上市类型，数组，1：A股，2：新三板，3：B股，4：港股，5：美股 |  |
| `data.listed_info.liststate` | String | 是 | 上市状态，0正常上市 1暂停上市 2终止上市 3恢复上市 9未上市 10资产重组弃用 |  |
| `data.listed_info.securitycode` | String | 是 | 证券代码，多个优先返回A股 |  |
| `data.headquarters_info` | Object | 是 | 所属总公司 |  |
| `data.headquarters_info.ename` | String | 是 | 总公司名称 |  |
| `data.headquarters_info.eid` | String | 是 | 总公司id |  |
| `data.coordinate_info` | Object | 是 | 坐标信息 |  |
| `data.coordinate_info.longitude` | String | 是 | 经度 |  |
| `data.coordinate_info.latitude` | String | 是 | 纬度 |  |
| `data.taxrating_list` | Array | 是 | 纳税评级信息 |  |
| `data.taxrating_list[].level` | String | 是 | 评级等级 |  |
| `data.taxrating_list[].year` | String | 是 | 获得年份 |  |
| `data.taxrating_list[].agency` | String | 是 | 评级单位 |  |
| `data.license_list` | Array | 是 | 行政许可信息 |  |
| `data.license_list[].name` | String | 是 | 许可文件名称 |  |
| `data.license_list[].number` | String | 是 | 许可文件编号 |  |
| `data.license_list[].start_date` | String | 是 | 有效期自 |  |
| `data.license_list[].end_date` | String | 是 | 有效期至 |  |
| `data.license_list[].department` | String | 是 | 许可机关 |  |
| `data.license_list[].content` | String | 是 | 许可内容 |  |
| `data.license_list[].status` | String | 是 | 状态，1：注销 2：正常 3：有效 4：无效 5：撤销 6：异议 7：吊销 8：变更 -1：其他 |  |
| `data.license_list[].source` | String | 是 | 来源，工商、信用中国，其他 |  |
| `data.domain_list` | Array | 是 | 网站域名备案 |  |
| `data.domain_list[].eid` | String | 是 | 公司eid |  |
| `data.domain_list[].ename` | String | 是 | 公司名称 |  |
| `data.domain_list[].home_url` | String | 是 | 网站首页网址 | 🔗 |
| `data.domain_list[].domain` | String | 是 | 网站域名 | 🔗 |
| `data.domain_list[].number` | String | 是 | 网站备案许可证号 |  |
| `data.domain_list[].check_date` | String | 是 | 登记批准时间 |  |
| `data.checkups_list` | Array | 是 | 抽查检查信息 |  |
| `data.checkups_list[].department` | String | 是 | 检查实施机关 |  |
| `data.checkups_list[].type` | String | 是 | 类型 |  |
| `data.checkups_list[].date` | String | 是 | 日期 |  |
| `data.checkups_list[].result` | String | 是 | 结果 |  |
| `data.financing_list` | Array | 是 | 融资信息 |  |
| `data.financing_list[].eid` | String | 是 | 所属企业eid |  |
| `data.financing_list[].round_date` | String | 是 | 融资时间 |  |
| `data.financing_list[].round` | String | 是 | 融资轮次 |  |
| `data.financing_list[].amount` | String | 是 | 融资金融 |  |
| `data.financing_list[].investors` | String | 是 | 投资人 |  |
| `data.logout_list` | Array | 是 | 简易注销信息 |  |
| `data.logout_list[].gs_sca_result` | String | 是 | 简易注销结果 |  |
| `data.logout_list[].notice_period_start` | String | 是 | 公告开始日期 |  |
| `data.logout_list[].notice_period_end` | String | 是 | 公告结束日期 |  |
| `data.logout_list[].name` | String | 是 | 企业名称 |  |
| `data.logout_list[].gs_sca_objections` | String | 是 | 异议信息 |  |
| `data.logout_list[].department` | String | 是 | 登记机关 |  |
| `data.logout_record_list` | Array | 是 | 注销备案 |  |
| `data.logout_record_list[].eid` | String | 是 | 企业eid |  |
| `data.logout_record_list[].ename` | String | 是 | 企业名称 |  |
| `data.logout_record_list[].credit_no` | String | 是 | 统一社会信用代码/注册号 |  |
| `data.logout_record_list[].belong_org` | String | 是 | 登记机关 |  |
| `data.logout_record_list[].audit_reg_date` | String | 是 | 清算组备案日期 |  |
| `data.logout_record_list[].audit_start_date` | String | 是 | 清算组成立日期 |  |
| `data.logout_record_list[].logout_reason` | String | 是 | 注销原因 |  |
| `data.logout_record_list[].audit_address` | String | 是 | 清算组办公地址 |  |
| `data.logout_record_list[].audit_leader` | String | 是 | 清算组负责人 |  |
| `data.logout_record_list[].audit_employees` | String | 是 | 清算组成员 |  |
| `data.logout_record_list[].creditor_start_date` | String | 是 | 债权人公告开始日期 |  |
| `data.logout_record_list[].creditor_end_date` | String | 是 | 债权人公告结束日期 |  |
| `data.logout_record_list[].creditor_announcement` | String | 是 | 公告内容 |  |
| `data.logout_record_list[].creditor_person` | String | 是 | 债权申报联系人 |  |
| `data.logout_record_list[].creditor_address` | String | 是 | 债权申报地址 |  |
| `data.logout_record_list[].cancel_date` | String | 是 | 终止注销决议日期 |  |
| `data.logout_record_list[].status` | String | 是 | 状态（2：已撤销 ；非2：已发布） |  |

### 55.29 合作风险排查

- Hub：`POST /api/v1/data/enterprise/55.29/query`；上游方法 GET（可选 GET/POST）；可调用
- 说明：企业综合风险排查，通过企业名称/统代一键获取企业在工商、司法、税务等各类风险信息。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `dimension` | String | 否 | 输出内容配置，默认返回全部字段，如需要选择字段返回，按照枚举输入选择输出数据，具体枚举见附件“55.29入参dimension映射关系表” |
| `is_history` | String | 否 | 是否查询历史数据，默认为0。枚举0：查询当前最新数据；1：查询历史数据 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.ent_info` | Object | 是 | 工商信息 |  |
| `data.ent_info.eid` | String | 是 | 企业唯一标识id |  |
| `data.ent_info.credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.ent_info.name` | String | 是 | 企业名称 |  |
| `data.ent_info.oper_name` | String | 是 | 法定代表人 |  |
| `data.ent_info.title` | String | 是 | 公司代表人职务 |  |
| `data.ent_info.status` | String | 是 | 登记状态 |  |
| `data.ent_info.start_date` | String | 是 | 成立日期，yyyy-mm-dd |  |
| `data.ent_info.regist_capi` | String | 是 | 注册资本 |  |
| `data.ent_info.actual_capi` | String | 是 | 实缴资本 |  |
| `data.ent_info.org_no` | String | 是 | 组织机构代码 |  |
| `data.ent_info.reg_no` | String | 是 | 工商注册号 |  |
| `data.ent_info.tax_num` | String | 是 | 纳税人识别号 |  |
| `data.ent_info.econ_kind` | String | 是 | 企业类型 |  |
| `data.ent_info.organization_code` | String | 是 | 组织分类代码，1560101：机关; 1560102：事业单位; 1560103：中央编办直接管理机构编制的群众团体 ;1560201：律师执业机构; 1560202：公证处; 1560203：基层法律服务所; 1560204：司法鉴定机构;1560205：仲裁委员会; 1560301：社会团体; 1560302：民办非企业单位; 1560303：基金会; 1560304：村民委员会; 1560305：居民委员会; 1560401：基层工会; 1560501：企业; 1560502：个体工商户; 1560503：农民专业合作社; 1560601：组级集体经济组织; 1560602：村级集体经济组织; 1560603：乡镇级集体经济组织; 1569999：其他; 3440101：香港; 4660101：澳门; 1580101：台湾 |  |
| `data.ent_info.term_start` | String | 是 | 开始营业期限，yyyy-mm-dd |  |
| `data.ent_info.term_end` | String | 是 | 结束营业期限，yyyy-mm-dd |  |
| `data.ent_info.qualification` | String | 是 | 纳税人资质 |  |
| `data.ent_info.collegues_num` | String | 是 | 人员规模 |  |
| `data.ent_info.canbao_count` | String | 是 | 参保人数 |  |
| `data.ent_info.check_date` | String | 是 | 核准日期，yyyy-mm-dd |  |
| `data.ent_info.belong_org` | String | 是 | 登记机关 |  |
| `data.ent_info.import_export_num` | String | 是 | 进出口企业代码 |  |
| `data.ent_info.fenname` | String | 是 | 英文名 |  |
| `data.ent_info.address` | String | 是 | 注册地址 |  |
| `data.ent_info.scope` | String | 是 | 经营范围 |  |
| `data.ent_info.brief` | String | 是 | 简介 |  |
| `data.ent_info.logo_url` | String | 是 | logo地址 | 🔗 |
| `data.ent_info.is_small` | String | 是 | 是否为小微企业库企业，1:是，0:不是 |  |
| `data.ent_info.scale` | String | 是 | 企业规模 |  |
| `data.ent_info.group_name` | String | 是 | 所属集团 |  |
| `data.ent_info.is_history` | String | 是 | 工商是否下架(0:否，1：是） |  |
| `data.district_info` | Object | 是 | 区域信息 |  |
| `data.district_info.province` | String | 是 | 省份 |  |
| `data.district_info.city` | String | 是 | 城市 |  |
| `data.district_info.district` | String | 是 | 区县 |  |
| `data.district_info.district_code` | String | 是 | 所属区域代码 |  |
| `data.industry_info` | Object | 是 | 行业信息 |  |
| `data.industry_info.indu_code_l1` | String | 是 | 一级行业代码 |  |
| `data.industry_info.indu_l1` | String | 是 | 一级行业描述 |  |
| `data.industry_info.indu_code_l2` | String | 是 | 二级行业代码 |  |
| `data.industry_info.indu_l2` | String | 是 | 二级行业描述 |  |
| `data.industry_info.indu_code_l3` | String | 是 | 三级行业代码 |  |
| `data.industry_info.indu_l3` | String | 是 | 三级行业描述 |  |
| `data.industry_info.indu_code_l4` | String | 是 | 四级行业代码 |  |
| `data.industry_info.indu_l4` | String | 是 | 四级行业描述 |  |
| `data.tags_list` | Array | 是 | 企业画像 |  |
| `data.tags_list[].tag_id` | String | 是 | 标签id |  |
| `data.tags_list[].tag_name` | String | 是 | 标签名称 |  |
| `data.judicial_cases_list` | Array | 是 | 案件串联列表 |  |
| `data.judicial_cases_list[].case_name` | String | 是 | 案件名称 |  |
| `data.judicial_cases_list[].case_type` | String | 是 | 案件类型 |  |
| `data.judicial_cases_list[].role_min_date` | String | 是 | 案件身份 |  |
| `data.judicial_cases_list[].case_cause_min_date` | String | 是 | 案由 |  |
| `data.judicial_cases_list[].case_no` | String | 是 | 案号 |  |
| `data.judicial_cases_list[].court` | String | 是 | 法院 |  |
| `data.judicial_cases_list[].newest_base_type` | String | 是 | 最新审理程序 |  |
| `data.casecount_list` | Array | 是 | 诉讼关系列表 |  |
| `data.casecount_list[].related_name` | String | 是 | 对方当事人 |  |
| `data.casecount_list[].cases_count` | String | 是 | 关联司法案件数量 |  |
| `data.casecount_list[].main_cause` | String | 是 | 主要案由 |  |
| `data.cases_list` | Array | 是 | 立案信息 |  |
| `data.cases_list[].case_no` | String | 是 | 案号 |  |
| `data.cases_list[].related_companies` | Array | 是 | 当事人 |  |
| `data.cases_list[].related_companies[].type` | String | 是 | 当事人类型 |  |
| `data.cases_list[].related_companies[].item` | String | 是 | 当事人id |  |
| `data.cases_list[].related_companies[].name` | String | 是 | 当事人姓名 |  |
| `data.cases_list[].related_companies[].role` | String | 是 | 当事人角色 |  |
| `data.cases_list[].related_companies[].clean_role` | String | 是 | 清洗后角色 |  |
| `data.cases_list[].case_cause` | String | 是 | 案由 |  |
| `data.cases_list[].start_date` | String | 是 | 立案时间 |  |
| `data.cases_list[].hearing_date` | String | 是 | 开庭时间 |  |
| `data.cases_list[].end_date` | String | 是 | 结束时间 |  |
| `data.cases_list[].case_status` | String | 是 | 案件状态 |  |
| `data.hearing_notices_list` | Array | 是 | 开庭公告列表 |  |
| `data.hearing_notices_list[].case_no` | String | 是 | 案号 |  |
| `data.hearing_notices_list[].pure_role` | String | 是 | 身份 |  |
| `data.hearing_notices_list[].related_companies` | Array | 是 | 当事人 |  |
| `data.hearing_notices_list[].related_companies[].role` | String | 是 | 当事人角色 |  |
| `data.hearing_notices_list[].related_companies[].pure_role` | String | 是 | 角色 |  |
| `data.hearing_notices_list[].related_companies[].item` | String | 是 | 当事人id |  |
| `data.hearing_notices_list[].related_companies[].name` | String | 是 | 当事人姓名 |  |
| `data.hearing_notices_list[].related_companies[].type` | String | 是 | 当事人类型 |  |
| `data.hearing_notices_list[].hearing_date` | String | 是 | 开庭时间 |  |
| `data.hearing_notices_list[].cause_action` | String | 是 | 案由 |  |
| `data.court_notices_list` | Array | 是 | 法院公告列表 |  |
| `data.court_notices_list[].type` | String | 是 | 公告类型 |  |
| `data.court_notices_list[].role` | String | 是 | 身份 |  |
| `data.court_notices_list[].people` | String | 是 | 当事人 |  |
| `data.court_notices_list[].date` | String | 是 | 发布时间 |  |
| `data.court_notices_list[].content` | String | 是 | 公告内容 |  |
| `data.send_notices_list` | Array | 是 | 送达公告 |  |
| `data.send_notices_list[].case_no` | String | 是 | 案号 |  |
| `data.send_notices_list[].case_reason` | String | 是 | 案由 |  |
| `data.send_notices_list[].related_companies` | Array | 是 | 当事人 |  |
| `data.send_notices_list[].court` | String | 是 | 法院 |  |
| `data.send_notices_list[].date` | String | 是 | 发布日期 |  |
| `data.send_notices_list[].content` | String | 是 | 内容 |  |
| `data.judgement_list` | Array | 是 | 裁判文书列表 |  |
| `data.judgement_list[].clean_role` | String | 是 | 案件身份 |  |
| `data.judgement_list[].trial_result` | String | 是 | 审判结果 |  |
| `data.judgement_list[].date` | String | 是 | 发布时间 |  |
| `data.judgement_list[].title` | String | 是 | 案件名称 |  |
| `data.judgement_list[].case_reasons` | String | 是 | 案由 |  |
| `data.judgement_list[].related_companies` | String | 是 | 身份 |  |
| `data.judgement_list[].related_companies.item` | String | 是 | id |  |
| `data.judgement_list[].related_companies.trial_result` | String | 是 | 结果 |  |
| `data.judgement_list[].related_companies.name` | String | 是 | 名称 |  |
| `data.judgement_list[].related_companies.role` | String | 是 | 角色 |  |
| `data.judgement_list[].related_companies.clean_role` | String | 是 | 清洗后角色 |  |
| `data.judgement_list[].related_companies.by` | String | 是 | 方式 |  |
| `data.judgement_list[].related_companies.type` | String | 是 | 类型 |  |
| `data.judgement_list[].standard_case_no` | String | 是 | 案号 |  |
| `data.judgement_list[].judgeresult` | String | 是 | 审判结果 |  |
| `data.judgement_list[].sub_amount` | Number | 是 | 请求标的 |  |
| `data.enforcement_list` | Array | 是 | 被执行人列表 |  |
| `data.enforcement_list[].standard_case_no` | String | 是 | 案号 |  |
| `data.enforcement_list[].amount` | String | 是 | 执行标的 |  |
| `data.enforcement_list[].court_name` | String | 是 | 执行法院 |  |
| `data.enforcement_list[].case_date` | String | 是 | 立案时间 |  |
| `data.executions_list` | Array | 是 | 失信信息列表 |  |
| `data.executions_list[].case_number` | String | 是 | 案号 |  |
| `data.executions_list[].doc_number` | String | 是 | 执行根据文号 |  |
| `data.executions_list[].amount` | String | 是 | 执行标的 |  |
| `data.executions_list[].date` | String | 是 | 立案时间 |  |
| `data.executions_list[].publish_date` | String | 是 | 发布日期 |  |
| `data.executions_list[].court` | String | 是 | 执行法院 |  |
| `data.executions_list[].execution_status` | String | 是 | 被执行人情况 |  |
| `data.judicial_freeze_list` | Array | 是 | 股权冻结列表 |  |
| `data.judicial_freeze_list[].detail_notice_no` | String | 是 | 执行通知书文号 |  |
| `data.judicial_freeze_list[].be_executed_person` | String | 是 | 被执行人 |  |
| `data.judicial_freeze_list[].object_company` | String | 是 | 冻结股权的标的企业 |  |
| `data.judicial_freeze_list[].amount` | String | 是 | 股权数额 |  |
| `data.judicial_freeze_list[].executive_court` | String | 是 | 执行法院 |  |
| `data.judicial_freeze_list[].start_date` | String | 是 | 开始日期 |  |
| `data.judicial_freeze_list[].end_date` | String | 是 | 结束日期 |  |
| `data.judicial_freeze_list[].detail_public_date` | String | 是 | 公示日期 |  |
| `data.restricted_consumer_list` | Array | 是 | 限制高消费列表 |  |
| `data.restricted_consumer_list[].standard_case_no` | String | 是 | 案号 |  |
| `data.restricted_consumer_list[].case_reason` | String | 是 | 案由 |  |
| `data.restricted_consumer_list[].court` | String | 是 | 执行法院 |  |
| `data.restricted_consumer_list[].filing_date` | String | 是 | 立案时间 |  |
| `data.restricted_consumer_list[].release_date` | String | 是 | 限制令发布日期 |  |
| `data.exit_limitation_list` | Array | 是 | 限制出境 |  |
| `data.exit_limitation_list[].standard_case_no` | String | 是 | 案号 |  |
| `data.exit_limitation_list[].pname` | String | 是 | 限制出境对象 |  |
| `data.exit_limitation_list[].ename` | String | 是 | 被执行人 |  |
| `data.exit_limitation_list[].amount` | String | 是 | 执行标的 |  |
| `data.exit_limitation_list[].publish_date` | String | 是 | 发布日期 |  |
| `data.exit_limitation_list[].url` | String | 是 | 内容 | 🔗 |
| `data.bidding_limitation_list` | Array | 是 | 限制招投标列表 |  |
| `data.bidding_limitation_list[].case_no` | String | 是 | 案号 |  |
| `data.bidding_limitation_list[].case_reason` | String | 是 | 执行案由 |  |
| `data.bidding_limitation_list[].amount` | String | 是 | 执行标的 |  |
| `data.bidding_limitation_list[].unexecuted_amount` | String | 是 | 未执行金额（元） |  |
| `data.bidding_limitation_list[].publish_date` | String | 是 | 发布日期 |  |
| `data.terminationcaseitem_list` | Array | 是 | 终本案件列表 |  |
| `data.terminationcaseitem_list[].case_no_terminal` | String | 是 | 案号 |  |
| `data.terminationcaseitem_list[].name` | String | 是 | 被执行人 |  |
| `data.terminationcaseitem_list[].court` | String | 是 | 执行法院 |  |
| `data.terminationcaseitem_list[].filing_date` | String | 是 | 立案时间 |  |
| `data.terminationcaseitem_list[].terminate_date` | String | 是 | 终本时间 |  |
| `data.terminationcaseitem_list[].amount` | String | 是 | 执行标的（元） |  |
| `data.terminationcaseitem_list[].fail_perform_amount` | String | 是 | 未履行金额（元） |  |
| `data.terminationcaseitem_list[].status` | String | 是 | 履行状态（0：未知；1：已履行；2：未履行完毕） |  |
| `data.auctions_list` | Array | 是 | 司法拍卖列表 |  |
| `data.auctions_list[].date` | String | 是 | 拍卖日期 |  |
| `data.auctions_list[].full_name` | String | 是 | 拍卖标的 |  |
| `data.auctions_list[].start_price` | String | 是 | 起拍价 |  |
| `data.auctions_list[].description` | String | 是 | 拍品介绍 |  |
| `data.abnormal_list` | Array | 是 | 经营异常 |  |
| `data.abnormal_list[].in_date` | String | 是 | 列入日期 |  |
| `data.abnormal_list[].department` | String | 是 | 做出决定机关（列入） |  |
| `data.abnormal_list[].in_reason` | String | 是 | 列入经营异常名录原因 |  |
| `data.abnormal_list[].out_date` | String | 是 | 移出日期 |  |
| `data.abnormal_list[].out_department` | String | 是 | 做出决定机关（移出） |  |
| `data.abnormal_list[].out_reason` | String | 是 | 移出经营异常名录原因 |  |
| `data.serious_illegal_list` | Array | 是 | 严重违法失信 |  |
| `data.serious_illegal_list[].ill_type` | String | 是 | 违法类别 |  |
| `data.serious_illegal_list[].in_reason` | String | 是 | 列入原因 |  |
| `data.serious_illegal_list[].in_date` | String | 是 | 列入日期 |  |
| `data.serious_illegal_list[].in_department` | String | 是 | 做出决定机关（列入） |  |
| `data.serious_illegal_list[].out_reason` | String | 是 | 移出原因 |  |
| `data.serious_illegal_list[].out_date` | String | 是 | 移出日期 |  |
| `data.serious_illegal_list[].out_department` | String | 是 | 做出决定机关（移出） |  |
| `data.administrative_punishment_list` | Array | 是 | 行政处罚列表 |  |
| `data.administrative_punishment_list[].number` | String | 是 | 行政处罚决定书文号 |  |
| `data.administrative_punishment_list[].illegal_type` | String | 是 | 违法行为类型 |  |
| `data.administrative_punishment_list[].content` | String | 是 | 行政处罚内容 |  |
| `data.administrative_punishment_list[].punish_amount` | String | 是 | 罚款金额 |  |
| `data.administrative_punishment_list[].district_name` | String | 是 | 作出行政处罚决定机关名称 |  |
| `data.administrative_punishment_list[].date` | String | 是 | 作出行政处罚决定日期 |  |
| `data.environment_punishment_list` | Array | 是 | 环保处罚 |  |
| `data.environment_punishment_list[].punish_date` | String | 是 | 处罚日期 |  |
| `data.environment_punishment_list[].document_no` | String | 是 | 决定文书号 |  |
| `data.environment_punishment_list[].illegal_type` | String | 是 | 违法行为类型 |  |
| `data.environment_punishment_list[].punishment_result` | String | 是 | 处罚内容 |  |
| `data.environment_punishment_list[].punish_amnt` | String | 是 | 罚款金额 |  |
| `data.environment_punishment_list[].standard_dep` | String | 是 | 做出处罚决定机关 |  |
| `data.labor_arbitration_list` | Array | 是 | 劳动仲裁 |  |
| `data.labor_arbitration_list[].case_no` | String | 是 | 案号 |  |
| `data.labor_arbitration_list[].case_reason` | String | 是 | 案由 |  |
| `data.labor_arbitration_list[].hearing_date` | String | 是 | 开庭日期 |  |
| `data.labor_arbitration_list[].department` | String | 是 | 发布机构 |  |
| `data.labor_arbitration_list[].related_companies` | Array | 是 | 当事人 |  |
| `data.labor_arbitration_list[].release_time` | String | 是 | 发布日期 |  |
| `data.black_list` | Array | 是 | 黑名单 |  |
| `data.black_list[].lists_type` | String | 是 | 黑名单类型(01政府黑名单 02环保失信黑名单 03应急管理部安全生产失信黑名单 04政府采购黑名单 05“屡禁不止、屡罚不改”黑名单 06 其他 07 假冒国企名单 08 军队采购失信名单 09 政府采购失信名单 10 供应商暂停名单 11 社会组织活动异常名录 12 社会组织严重违法失信名单 13 涉金融领域黑名单 14 价格招采信用评价失信名单） |  |
| `data.black_list[].black_basis` | String | 是 | 黑名单认定依据 |  |
| `data.black_list[].maintain_department` | String | 是 | 认定部门 |  |
| `data.black_list[].department_level` | String | 是 | 认定等级（根据发布机关所属行政等级区分，枚举值为01国家级 02省级 03市级 04县级 05乡级 06其他） |  |
| `data.black_list[].in_lists_date` | String | 是 | 列入日期 |  |
| `data.black_list[].details` | String | 是 | 内容 |  |
| `data.black_list[].punishment_result` | String | 是 | 处罚结果 |  |
| `data.black_list[].data_from` | String | 是 | 数据来源（9910019 信用中国 9910999 启信宝自建） |  |
| `data.bankruptcy_list` | Array | 是 | 破产案件 |  |
| `data.bankruptcy_list[].standard_case_no` | String | 是 | 案号 |  |
| `data.bankruptcy_list[].case_kind` | String | 是 | 案件类型(1破产审查案件、2破产案件、6破产上诉案件、7破产监督案件为破产案件，3强制清算申请审查案件、4强制清算案件、5强制清算上诉案件、8强制清算监督案件为强制清算) |  |
| `data.bankruptcy_list[].court` | String | 是 | 经办法院 |  |
| `data.bankruptcy_list[].name` | String | 是 | 被申请人 |  |
| `data.bankruptcy_list[].app_name` | String | 是 | 申请人 |  |
| `data.bankruptcy_list[].pub_date` | String | 是 | 公开日期 |  |
| `data.clear_account_list` | Array | 是 | 清算信息 |  |
| `data.clear_account_list[].leader` | String | 是 | 清算组负责人 |  |
| `data.clear_account_list[].employees` | String | 是 | 清算组成员 |  |
| `data.equityquality_list` | Array | 是 | 股权出质列表 |  |
| `data.equityquality_list[].date` | String | 是 | 登记日期 |  |
| `data.equityquality_list[].number` | String | 是 | 登记编号 |  |
| `data.equityquality_list[].pledgor` | String | 是 | 出质人 |  |
| `data.equityquality_list[].pawnee` | String | 是 | 质权人 |  |
| `data.equityquality_list[].object_company` | String | 是 | 标的方 |  |
| `data.equityquality_list[].status` | String | 是 | 状态 |  |
| `data.mortages_list` | Array | 是 | 动产抵押 |  |
| `data.mortages_list[].number` | String | 是 | 登记编号 |  |
| `data.mortages_list[].department` | String | 是 | 登记机关 |  |
| `data.mortages_list[].guarantees` | String | 是 | 抵押物 |  |
| `data.mortages_list[].type` | String | 是 | 被担保债权种类 |  |
| `data.mortages_list[].amount` | String | 是 | 被担保债权数额 |  |
| `data.mortages_list[].status` | String | 是 | 状态 |  |
| `data.mortages_list[].date` | String | 是 | 登记日期 |  |
| `data.mortages_list[].period` | String | 是 | 债务人履行债务的期限 |  |
| `data.overduetaxs_list` | Array | 是 | 欠税信息 |  |
| `data.overduetaxs_list[].taxpayer_num` | String | 是 | 纳税人识别号 |  |
| `data.overduetaxs_list[].overdue_type` | String | 是 | 欠税税种 |  |
| `data.overduetaxs_list[].overdue_amount` | String | 是 | 欠税金额 |  |
| `data.overduetaxs_list[].curr_overdue_amount` | String | 是 | 当前新发生的欠税额 |  |
| `data.overduetaxs_list[].pub_date` | String | 是 | 发布时间 |  |
| `data.overduetaxs_list[].pub_department` | String | 是 | 发布单位 |  |
| `data.huge_tax_punishment_list` | Array | 是 | 重大税收违法 |  |
| `data.huge_tax_punishment_list[].time` | String | 是 | 发布时间 |  |
| `data.huge_tax_punishment_list[].pub_department` | String | 是 | 所属税务机关 |  |
| `data.huge_tax_punishment_list[].case_type` | String | 是 | 案件性质 |  |
| `data.huge_tax_punishment_list[].url` | String | 是 | 详情 | 🔗 |
| `data.abnormal_enterprises_list` | Array | 是 | 非正常户 |  |
| `data.abnormal_enterprises_list[].judge_date` | String | 是 | 认定日期 |  |
| `data.abnormal_enterprises_list[].tax_num` | String | 是 | 纳税人识别号 |  |
| `data.abnormal_enterprises_list[].overdue_type` | String | 是 | 欠税税种 |  |
| `data.abnormal_enterprises_list[].overdue_amount` | String | 是 | 欠税金额 |  |
| `data.abnormal_enterprises_list[].judge_department` | String | 是 | 认定单位 |  |
| `data.knowledge_properites_list` | Array | 是 | 知识产权出质 |  |
| `data.knowledge_properites_list[].name` | String | 是 | 名称 |  |
| `data.knowledge_properites_list[].pledgor` | String | 是 | 出质人 |  |
| `data.knowledge_properites_list[].pawnee` | String | 是 | 质权人 |  |
| `data.knowledge_properites_list[].status` | String | 是 | 状态 |  |
| `data.knowledge_properites_list[].public_date` | String | 是 | 公示日期 |  |
| `data.simple_cancellation_list` | Array | 是 | 简易注销 |  |
| `data.simple_cancellation_list[].name` | String | 是 | 企业名称 |  |
| `data.simple_cancellation_list[].notice_period_start` | String | 是 | 公示开始日期 |  |
| `data.simple_cancellation_list[].notice_period_end` | String | 是 | 公示结束日期 |  |
| `data.simple_cancellation_list[].result` | Array | 是 | 简易注销结果 |  |
| `data.logout_announcement_list` | Array | 是 | 注销备案 |  |
| `data.logout_announcement_list[].audit_reg_date` | String | 是 | 清算组备案日期 |  |
| `data.logout_announcement_list[].creditor_start_date` | String | 是 | 债权人公告开始日期 |  |
| `data.logout_announcement_list[].creditor_end_date` | String | 是 | 债权人公告结束日期 |  |
| `data.logout_announcement_list[].logout_reason` | String | 是 | 注销原因 |  |
| `data.logout_announcement_list[].status` | String | 是 | 状态(2：已撤销，非2：已发布) |  |
| `data.change_list` | Array | 是 | 变更记录 |  |
| `data.change_list[].change_date` | String | 是 | 变更日期 |  |
| `data.change_list[].change_item` | String | 是 | 变更事项 |  |
| `data.change_list[].before_content` | String | 是 | 变更前 |  |
| `data.change_list[].after_content` | String | 是 | 变更后 |  |

### 51.17 董监高信息洞察

- Hub：`POST /api/v1/data/enterprise/51.17/query`；上游方法 GET（可选 GET/POST）；可调用
- 说明：企业董监高信息洞察，通过企业名称加人名获取董监高相关信息。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `p_name` | String | 是 | 人员姓名 |
| `dimension` | String | 否 | 返回内容。默认返回所有，如果输入序号，则输出对应的list，输入多个序号，则返回多个list, 多个序号用英文逗号连接，如3,4,5；具体映射关系见“51.17入参dimension映射关系表” |
| `is_history` | String | 否 | 是否查询历史数据，枚举：0 查询当前最新数据，1 查询历史数据，默认枚举0，查询当前最新数据 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.basic_info` | Object | 是 | 基本信息 |  |
| `data.basic_info.partners_list` | Array | 是 | 合作伙伴 |  |
| `data.basic_info.partners_list[].pname` | String | 是 | 合作伙伴姓名 |  |
| `data.basic_info.partners_list[].cname` | String | 是 | 任职企业 |  |
| `data.basic_info.partners_list[].start_date` | String | 是 | 企业注册日期 |  |
| `data.basic_info.partners_list[].status` | String | 是 | 经营状态 |  |
| `data.basic_info.partners_list[].job_title` | String | 是 | 职位 |  |
| `data.basic_info.oper_list` | Array | 是 | 担任法人的企业列表 |  |
| `data.basic_info.oper_list[].name` | String | 是 | 法定代表人 |  |
| `data.basic_info.oper_list[].pid` | String | 是 | 人员id |  |
| `data.basic_info.oper_list[].company` | String | 是 | 企业名称 |  |
| `data.basic_info.oper_list[].credit_no` | String | 是 | 企业统一社会信用代码/注册号 |  |
| `data.basic_info.oper_list[].eid` | String | 是 | 企业id |  |
| `data.basic_info.oper_list[].regist_date` | String | 是 | 企业注册日期 |  |
| `data.basic_info.oper_list[].company_type` | String | 是 | 企业类型 |  |
| `data.basic_info.oper_list[].company_status` | String | 是 | 企业经营状态 |  |
| `data.basic_info.oper_list[].regist_capi` | String | 是 | 企业注册资本 |  |
| `data.basic_info.stockholder_list` | Array | 是 | 担任股东的企业列表 |  |
| `data.basic_info.stockholder_list[].name` | String | 是 | 自然人名称 |  |
| `data.basic_info.stockholder_list[].pid` | String | 是 | 人员id |  |
| `data.basic_info.stockholder_list[].oper_name` | String | 是 | 企业法人 |  |
| `data.basic_info.stockholder_list[].oper_pid` | String | 是 | 人员id |  |
| `data.basic_info.stockholder_list[].company` | String | 是 | 企业名称 |  |
| `data.basic_info.stockholder_list[].eid` | String | 是 | 企业id |  |
| `data.basic_info.stockholder_list[].credit_no` | String | 是 | 企业统一社会信用代码/注册号 |  |
| `data.basic_info.stockholder_list[].company_type` | String | 是 | 企业类型 |  |
| `data.basic_info.stockholder_list[].company_status` | String | 是 | 企业经营状态 |  |
| `data.basic_info.stockholder_list[].regist_capi` | String | 是 | 企业注册资本 |  |
| `data.basic_info.stockholder_list[].regist_date` | String | 是 | 企业注册日期 |  |
| `data.basic_info.stockholder_list[].should_capi` | String | 是 | 认缴出资 |  |
| `data.basic_info.stockholder_list[].percent` | String | 是 | 出资比例 |  |
| `data.basic_info.manager_list` | Array | 是 | 担任高管的企业列表 |  |
| `data.basic_info.manager_list[].name` | String | 是 | 自然人名称 |  |
| `data.basic_info.manager_list[].pid` | String | 是 | 人员id |  |
| `data.basic_info.manager_list[].oper_name` | String | 是 | 企业法人 |  |
| `data.basic_info.manager_list[].oper_pid` | String | 是 | 法人id |  |
| `data.basic_info.manager_list[].company` | String | 是 | 企业名称 |  |
| `data.basic_info.manager_list[].credit_no` | String | 是 | 企业统一社会信用代码/注册号 |  |
| `data.basic_info.manager_list[].regist_date` | String | 是 | 企业注册日期 |  |
| `data.basic_info.manager_list[].eid` | String | 是 | 企业id |  |
| `data.basic_info.manager_list[].company_type` | String | 是 | 企业类型 |  |
| `data.basic_info.manager_list[].company_status` | String | 是 | 企业经营状态 |  |
| `data.basic_info.manager_list[].regist_capi` | String | 是 | 企业注册资本 |  |
| `data.basic_info.manager_list[].title` | String | 是 | 职务 |  |
| `data.basic_info.investment_list` | Array | 是 | 控股企业列表 |  |
| `data.basic_info.investment_list[].invest_name` | String | 是 | 被投资企业名称 |  |
| `data.basic_info.investment_list[].invest_eid` | String | 是 | 被投资企业eid |  |
| `data.basic_info.investment_list[].invest_oper_name` | String | 是 | 被投资企业法定代表人 |  |
| `data.basic_info.investment_list[].invest_credit_no` | String | 是 | 被投资企业统一社会信用代码 |  |
| `data.basic_info.investment_list[].invest_status` | String | 是 | 被投资企业状态 |  |
| `data.basic_info.investment_list[].invest_start_date` | String | 是 | 被投资企业成立日期 |  |
| `data.basic_info.investment_list[].invest_percent` | String | 是 | 总投资比例 |  |
| `data.basic_info.investment_list[].direct_percent` | String | 是 | 直接投资比例 |  |
| `data.basic_info.investment_list[].invest_level` | String | 是 | 最短投资层级 |  |
| `data.basic_info.investment_list[].invest_desc` | String | 是 | 投资描述 |  |
| `data.basic_info.investment_list[].invest_relationship_path` | String | 是 | 投资路径 |  |
| `data.basic_info.investment_list[].invest_path_count` | String | 是 | 投资路径数量 |  |
| `data.basic_info.investment_list[].his_direct_invest` | String | 是 | 是否历史直接投资（0否1是） |  |
| `data.basic_info.investment_list[].end_date` | String | 是 | 历史投资退出日期 |  |
| `data.basic_info.actual_controller_list` | Array | 是 | 实控企业列表 |  |
| `data.basic_info.actual_controller_list[].control_ename` | String | 是 | 实控企业名称 |  |
| `data.basic_info.actual_controller_list[].control_eid` | String | 是 | 实控企业eid |  |
| `data.basic_info.actual_controller_list[].total_percent` | String | 是 | 持股比例 |  |
| `data.basic_info.actual_controller_list[].control_credit_no` | String | 是 | 实控企业统一社会信用代码 |  |
| `data.basic_info.actual_controller_list[].control_path` | String | 是 | 实控人路径 |  |
| `data.basic_info.actual_controller_list[].control_reg_no` | String | 是 | 实控企业注册号 |  |
| `data.basic_info.actual_controller_list[].control_status` | String | 是 | 实控企业状态 |  |
| `data.basic_info.actual_controller_list[].control_regist_capi` | String | 是 | 实控企业注册资本 |  |
| `data.basic_info.actual_controller_list[].control_oper_name` | String | 是 | 实控企业法定代表人 |  |
| `data.risk_info` | Object | 是 | 风险信息 |  |
| `data.risk_info.restricted_consumer_list` | Array | 是 | 限制高消费列表 |  |
| `data.risk_info.restricted_consumer_list[].case_no` | String | 是 | 案号 |  |
| `data.risk_info.restricted_consumer_list[].court` | String | 是 | 执行法院 |  |
| `data.risk_info.restricted_consumer_list[].case_reason` | String | 是 | 案由 |  |
| `data.risk_info.restricted_consumer_list[].filing_date` | String | 是 | 立案时间 |  |
| `data.risk_info.restricted_consumer_list[].release_date` | String | 是 | 限制令发布日期 |  |
| `data.risk_info.restricted_consumer_list[].content` | String | 是 | 内容 |  |
| `data.risk_info.restricted_consumer_list[].source` | String | 是 | 地址 |  |
| `data.risk_info.judicial_freeze_list` | Array | 是 | 股权冻结 |  |
| `data.risk_info.judicial_freeze_list[].name` | String | 是 | 被执行人 |  |
| `data.risk_info.judicial_freeze_list[].company_name` | String | 是 | 冻结股权标的企业 |  |
| `data.risk_info.judicial_freeze_list[].number` | String | 是 | 执行通知书文号 |  |
| `data.risk_info.judicial_freeze_list[].amount` | String | 是 | 股权数额 |  |
| `data.risk_info.judicial_freeze_list[].executive_court` | String | 是 | 执行法院 |  |
| `data.risk_info.judicial_freeze_list[].status` | String | 是 | 类型/状态 |  |
| `data.risk_info.judicial_freeze_list[].detail_freeze_start_date` | String | 是 | 股权冻结开始时间 |  |
| `data.risk_info.judicial_freeze_list[].detail_freeze_end_date` | String | 是 | 股权冻结结束时间 |  |
| `data.risk_info.equity_pledge_list` | Array | 是 | 股权出质 |  |
| `data.risk_info.equity_pledge_list[].pledgor` | String | 是 | 出质人 |  |
| `data.risk_info.equity_pledge_list[].pawnee` | String | 是 | 质权人 |  |
| `data.risk_info.equity_pledge_list[].number` | String | 是 | 登记编号 |  |
| `data.risk_info.equity_pledge_list[].object_company` | String | 是 | 出质股权标的企业 |  |
| `data.risk_info.equity_pledge_list[].pledgor_amount` | String | 是 | 出质股权数额（万元） |  |
| `data.risk_info.equity_pledge_list[].date` | String | 是 | 登记日期 |  |
| `data.risk_info.equity_pledge_list[].status` | String | 是 | 状态 |  |
| `data.risk_info.equity_mortgage_list` | Array | 是 | 股权质押 |  |
| `data.risk_info.equity_mortgage_list[].noticedate` | String | 是 | 公告日期 |  |
| `data.risk_info.equity_mortgage_list[].p_name` | String | 是 | 人员姓名 |  |
| `data.risk_info.equity_mortgage_list[].frozentype` | String | 是 | 质押冻结类型 |  |
| `data.risk_info.equity_mortgage_list[].sharetype` | String | 是 | 质押股份类型 |  |
| `data.risk_info.equity_mortgage_list[].frozenstartdate` | String | 是 | 质押/冻结起始日 |  |
| `data.risk_info.equity_mortgage_list[].freedate` | String | 是 | 质押/冻结截止日 |  |
| `data.risk_info.equity_mortgage_list[].ghdate` | String | 是 | 过户日期 |  |
| `data.risk_info.equity_mortgage_list[].freedtaeinad` | String | 是 | 实际解除日期 |  |
| `data.risk_info.equity_mortgage_list[].frozenname` | String | 是 | 实施质押冻结机构 |  |
| `data.risk_info.equity_mortgage_list[].frozeneid` | String | 是 | 质押冻结机构代码 |  |
| `data.risk_info.equity_mortgage_list[].invamount` | String | 是 | 涉及金额 |  |
| `data.risk_info.equity_mortgage_list[].sharehdnum` | String | 是 | 所持股数（万股） |  |
| `data.risk_info.equity_mortgage_list[].achgshare` | String | 是 | 变动后股数 |  |
| `data.risk_info.equity_mortgage_list[].sharefrozennum` | String | 是 | 质押/冻结股数（万股） |  |
| `data.risk_info.equity_mortgage_list[].noreleasnum` | String | 是 | 剩余未解押数 |  |
| `data.risk_info.equity_mortgage_list[].amtsharefrozen` | String | 是 | 累计质押股数（万股） |  |
| `data.risk_info.equity_mortgage_list[].frozenratio` | String | 是 | 质押/冻结占所持股比例 |  |
| `data.risk_info.equity_mortgage_list[].frozenintotal` | String | 是 | 质押/冻结占总股本比例 |  |
| `data.risk_info.equity_mortgage_list[].achgratio` | String | 是 | 变动后股数占总股本比例 |  |
| `data.risk_info.equity_mortgage_list[].amtsharerepo` | String | 是 | 累计质押/约定回购股数（万股） |  |
| `data.risk_info.equity_mortgage_list[].amtshratio` | String | 是 | 累计质押数占所持股比例 |  |
| `data.risk_info.equity_mortgage_list[].amtfrozenratio` | String | 是 | -累计质押股数占总股本比例 |  |
| `data.risk_info.equity_mortgage_list[].amtreporatio` | String | 是 | 累计质押/约定回购股数占总股本比例 |  |
| `data.risk_info.equity_mortgage_list[].ndateamtsharerepo` | String | 是 | 截止公告日累计质押数（股） |  |
| `data.risk_info.equity_mortgage_list[].ndateamtshatoeqra` | String | 是 | 截止公告日累计质押数占总股本比例 |  |
| `data.risk_info.equity_mortgage_list[].ndateamtshratio` | String | 是 | 截止公告日累计质押数占所持股比例 |  |
| `data.risk_info.equity_mortgage_list[].frozendateexplain` | String | 是 | 质押/冻结期限描述 |  |
| `data.risk_info.equity_mortgage_list[].pledgepur` | String | 是 | 质押目的（"001贷款 002担保 003授信额度"） |  |
| `data.risk_info.equity_mortgage_list[].meunfrpled` | String | 是 | 解除质押冻结方式 |  |
| `data.risk_info.equity_mortgage_list[].frozprogres` | String | 是 | 质押冻结进度（初始质押 初始质押回购 初始约定回购 初始冻结 初始托管 轮候冻结 补充质押 预计解除 到期解除 部分解除） |  |
| `data.risk_info.equity_mortgage_list[].relinfocode` | String | 是 | 公告编码 |  |
| `data.risk_info.equity_mortgage_list[].frozenreason` | String | 是 | 质押/冻结事由 |  |
| `data.risk_info.equity_mortgage_list[].remark` | String | 是 | 备注 |  |
| `data.related_enterprise_risk_info` | Object | 是 | 关联企业风险 |  |
| `data.related_enterprise_risk_info.judgement_list` | Array | 是 | 裁判文书列表 |  |
| `data.related_enterprise_risk_info.judgement_list[].name` | String | 是 | 企业名称 |  |
| `data.related_enterprise_risk_info.judgement_list[].position` | String | 是 | 投资及任职关系 |  |
| `data.related_enterprise_risk_info.judgement_list[].num` | Number | 是 | 数量 |  |
| `data.related_enterprise_risk_info.enforcement_list` | Array | 是 | 被执行人列表 |  |
| `data.related_enterprise_risk_info.enforcement_list[].name` | String | 是 | 企业名称 |  |
| `data.related_enterprise_risk_info.enforcement_list[].position` | String | 是 | 投资及任职关系 |  |
| `data.related_enterprise_risk_info.enforcement_list[].num` | Number | 是 | 数量 |  |
| `data.related_enterprise_risk_info.execution_list` | Array | 是 | 失信信息列表 |  |
| `data.related_enterprise_risk_info.execution_list[].name` | String | 是 | 企业名称 |  |
| `data.related_enterprise_risk_info.execution_list[].position` | String | 是 | 投资及任职关系 |  |
| `data.related_enterprise_risk_info.execution_list[].num` | Number | 是 | 数量 |  |
| `data.related_enterprise_risk_info.consumption_restriction_list` | Array | 是 | 限制高消费列表 |  |
| `data.related_enterprise_risk_info.consumption_restriction_list[].name` | String | 是 | 企业名称 |  |
| `data.related_enterprise_risk_info.consumption_restriction_list[].position` | String | 是 | 投资及任职关系 |  |
| `data.related_enterprise_risk_info.consumption_restriction_list[].num` | Number | 是 | 数量 |  |
| `data.related_enterprise_risk_info.final_case_list` | Array | 是 | 终本案件列表 |  |
| `data.related_enterprise_risk_info.final_case_list[].name` | String | 是 | 企业名称 |  |
| `data.related_enterprise_risk_info.final_case_list[].position` | String | 是 | 投资及任职关系 |  |
| `data.related_enterprise_risk_info.final_case_list[].num` | Number | 是 | 数量 |  |

### 55.82 企业信用全景报告-JOB申请

- Hub：`POST /api/v1/data/enterprise/55.82/query`；上游方法 GET；**不可调用**（无公开价，返回 403 `enterprise_price_negotiated`）
- 说明：全面查询企业信息，多维度分析企业风险，综合评估企业运营状态。通过report_id查询36.99获取文档链接

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `time_range` | Number | 否 | 1.近1年 3.近3年 5.近5年 0.全部 默认1 |
| `dimension` | String | 否 | 输出内容配置。默认返回全部数据维度，如需要选择维度返回，按照枚举输入选择输出数据，具体枚举见附件“入参dimension映射关系表” |
| `include_history` | Number | 否 | 是否查询历史数据，默认为0。枚举：0 当前最新数据，1 全部数据（包含历史） |
| `report_format` | String | 否 | 报告形式：0 json ，1 文件，仅单选 默认为1 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.name` | String | 是 | 企业名称（若report_format=1） |  |
| `data.report_id` | String | 是 | 报告 id |  |
| `data.overview` | Object | 是 | 企业概览（若report_format=0） |  |
| `data.overview.name` | String | 是 | 企业名称 |  |
| `data.overview.credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.overview.start_date` | String | 是 | 成立日期，yyyy-mm-dd |  |
| `data.overview.credit_score` | Array | 是 | 企业评价 |  |
| `data.overview.credit_score[].score` | String | 是 | 企信分 |  |
| `data.overview.credit_score[].total_rank` | String | 是 | 启信分排名 |  |
| `data.overview.credit_score[].growth_score` | String | 是 | 成长性 |  |
| `data.overview.credit_score[].growth_rank` | String | 是 | 成长性-排名 |  |
| `data.overview.credit_score[].intellectual_property_score` | String | 是 | 知识产权 |  |
| `data.overview.credit_score[].intellectual_property_rank` | String | 是 | 知识产权-行业排名 |  |
| `data.overview.credit_score[].scale_score` | String | 是 | 企业规模 |  |
| `data.overview.credit_score[].scale_rank` | String | 是 | 企业规模-行业排名 |  |
| `data.overview.credit_score[].quality_score` | String | 是 | 经营质量 |  |
| `data.overview.credit_score[].quality_rank` | String | 是 | 经营质量-行业排名 |  |
| `data.overview.credit_score[].capital_background_score` | String | 是 | 资本背景 |  |
| `data.overview.credit_score[].capital_background_rank` | String | 是 | 资本背景-行业排名 |  |
| `data.overview.business_overview` | Object | 是 | 企业概况 |  |
| `data.overview.business_overview.ent_count` | String | 是 | 企业基础信息数量 |  |
| `data.overview.business_overview.sharehold_count` | String | 是 | 股权信息数量 |  |
| `data.overview.business_overview.business_count` | String | 是 | 经营信息数量 |  |
| `data.overview.business_overview.business_risk_count` | String | 是 | 经营风险数量 |  |
| `data.overview.business_overview.judicial_risk_count` | String | 是 | 司法风险数量 |  |
| `data.ent_info` | Object | 是 | 工商信息 |  |
| `data.ent_info.credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.ent_info.name` | String | 是 | 企业名称 |  |
| `data.ent_info.oper_name` | String | 是 | 法定代表人 |  |
| `data.ent_info.status` | String | 是 | 登记状态 |  |
| `data.ent_info.start_date` | String | 是 | 成立日期，yyyy-mm-dd |  |
| `data.ent_info.regist_capi` | String | 是 | 注册资本 |  |
| `data.ent_info.org_no` | String | 是 | 组织机构代码 |  |
| `data.ent_info.reg_no` | String | 是 | 工商注册号 |  |
| `data.ent_info.econ_kind` | String | 是 | 企业类型 |  |
| `data.ent_info.term_start` | String | 是 | 开始营业期限，yyyy-mm-dd |  |
| `data.ent_info.term_end` | String | 是 | 结束营业期限，yyyy-mm-dd |  |
| `data.ent_info.canbao_count` | String | 是 | 参保人数 |  |
| `data.ent_info.belong_org` | String | 是 | 登记机关 |  |
| `data.ent_info.address` | String | 是 | 注册地址 |  |
| `data.ent_info.scope` | String | 是 | 经营范围 |  |
| `data.ent_info.scale` | String | 是 | 企业规模 |  |
| `data.employees_list` | Array | 是 | 主要人员信息 |  |
| `data.employees_list[].name` | String | 是 | 姓名 |  |
| `data.employees_list[].title` | String | 是 | 职位 |  |
| `data.employees_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.change_record_list` | Array | 是 | 变更记录 |  |
| `data.change_record_list[].change_date` | String | 是 | 变更日期 |  |
| `data.change_record_list[].change_item` | String | 是 | 变更名称 |  |
| `data.change_record_list[].type` | String | 是 | 变更分类 |  |
| `data.change_record_list[].before_content` | String | 是 | 变更前 |  |
| `data.change_record_list[].after_content` | String | 是 | 变更后 |  |
| `data.change_record_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.partners_list` | Array | 是 | 股东信息(工商登记股东） |  |
| `data.partners_list[].stock_name` | String | 是 | 股东名称 |  |
| `data.partners_list[].credit_no` | String | 是 | 股东credit_no |  |
| `data.partners_list[].stock_type` | String | 是 | 股东类型 |  |
| `data.partners_list[].stock_percent` | String | 是 | 持股比例 |  |
| `data.partners_list[].total_should_capi` | String | 是 | 认缴出资 |  |
| `data.partners_list[].total_real_capi` | String | 是 | 实缴出资 |  |
| `data.partners_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.invest_list` | Array | 是 | 对外投资信息 |  |
| `data.invest_list[].invest_name` | String | 是 | 被投资企业名称 |  |
| `data.invest_list[].invest_status` | String | 是 | 被投资企业状态 |  |
| `data.invest_list[].invest_oper_name` | String | 是 | 被投资企业法定代表人 |  |
| `data.invest_list[].stock_percent` | String | 是 | 投资比例 |  |
| `data.invest_list[].invest_start_date` | String | 是 | 被投资企业成立日期 |  |
| `data.invest_list[].invest_credit_no` | String | 是 | 被投资公司统一社会信用代码 |  |
| `data.invest_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.group_info` | Array | 是 | 所属集团 |  |
| `data.group_info[].group_name` | String | 是 | 所属集团 |  |
| `data.group_info[].group_eid` | String | 是 | 集团eid |  |
| `data.group_info[].group_logo` | String | 是 | 集团logo | 🔗 |
| `data.actual_controller_info` | Array | 是 | 实际控制人 |  |
| `data.actual_controller_info[].entity_name` | String | 是 | 实控人名称 |  |
| `data.actual_controller_info[].total_percent` | String | 是 | 实控人总持股 |  |
| `data.actual_controller_info[].path` | String | 是 | 实控人关系路径 |  |
| `data.benefit_list` | String | 是 | 受益所有人 |  |
| `data.benefit_list.entity_name` | String | 是 | 受益所有人名称 |  |
| `data.benefit_list.total_percent` | String | 是 | 投资比例 |  |
| `data.benefit_list.path` | String | 是 | 持股路径 |  |
| `data.customer_list` | Array | 是 | 客户信息 |  |
| `data.customer_list[].related_ename` | String | 是 | 客户企业名称 |  |
| `data.customer_list[].report_date` | String | 是 | 报告日期 |  |
| `data.customer_list[].trade_amount` | String | 是 | 交易金额 |  |
| `data.customer_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.supplier_list` | Array | 是 | 供应商信息 |  |
| `data.supplier_list[].related_ename` | String | 是 | 供应商企业名称 |  |
| `data.supplier_list[].report_date` | String | 是 | 报告日期 |  |
| `data.supplier_list[].trade_amount` | String | 是 | 交易金额 |  |
| `data.supplier_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.product_list` | Array | 是 | 产品信息 |  |
| `data.product_list[].logo` | String | 是 | logo链接 | 🔗 |
| `data.product_list[].website` | String | 是 | 项目地址 | 🔗 |
| `data.product_list[].brief` | String | 是 | 简介 |  |
| `data.product_list[].name` | String | 是 | 产品名称 |  |
| `data.product_list[].status` | String | 是 | 运营状态 |  |
| `data.similars_list` | Array | 是 | 竞品信息 |  |
| `data.similars_list[].logo` | String | 是 | 竞品logo | 🔗 |
| `data.similars_list[].sim_eid` | String | 是 | 竞品所属企业id |  |
| `data.similars_list[].ename` | String | 是 | 竞品所属企业 |  |
| `data.similars_list[].name` | String | 是 | 竞品名称 |  |
| `data.similars_list[].category` | String | 是 | 竞品类别 |  |
| `data.similars_list[].date` | String | 是 | 竞品成立时间 |  |
| `data.similars_list[].brief` | String | 是 | 竞品简介 |  |
| `data.similars_list[].round` | String | 是 | 竞品轮次 |  |
| `data.financing_list` | Array | 是 | 融资信息 |  |
| `data.financing_list[].round_date` | String | 是 | 融资时间 |  |
| `data.financing_list[].round` | String | 是 | 融资轮次 |  |
| `data.financing_list[].amount` | String | 是 | 融资金融 |  |
| `data.financing_list[].investors` | String | 是 | 投资人 |  |
| `data.financing_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.certificate_list` | Array | 是 | 资质信息 |  |
| `data.certificate_list[].num` | String | 是 | 证书编号 |  |
| `data.certificate_list[].status` | String | 是 | 状态 |  |
| `data.certificate_list[].type` | String | 是 | 资质证书类型 |  |
| `data.certificate_list[].issue_date` | String | 是 | 发证时间 |  |
| `data.certificate_list[].validity_end` | String | 是 | 截止日期 |  |
| `data.certificate_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.bidding_list` | Array | 是 | 招投标 |  |
| `data.bidding_list[].title` | String | 是 | 招投标标题 |  |
| `data.bidding_list[].type` | String | 是 | 公告类型 |  |
| `data.bidding_list[].date` | String | 是 | 发布时间 |  |
| `data.bidding_list[].status` | String | 是 | 招投标状态 |  |
| `data.bidding_list[].money` | String | 是 | 中标金额 |  |
| `data.bidding_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.credit_levels_list` | Array | 是 | 进出口信用 |  |
| `data.credit_levels_list[].ename` | String | 是 | 公司名 |  |
| `data.credit_levels_list[].credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.credit_levels_list[].customs_num` | String | 是 | 海关注册编码 |  |
| `data.credit_levels_list[].credit_levels_new` | String | 是 | 信用等级 |  |
| `data.credit_levels_list[].credit_num` | String | 是 | 认证证书编码 |  |
| `data.credit_levels_list[].credit_time` | String | 是 | 认定日期 |  |
| `data.credit_levels_list[].customs_reg` | String | 是 | 注册海关 |  |
| `data.credit_levels_list[].business_category` | String | 是 | 经营类别 |  |
| `data.credit_levels_list[].reg_date` | String | 是 | 注册日期 |  |
| `data.credit_levels_list[].administrative_divisions` | String | 是 | 行政区划 |  |
| `data.credit_levels_list[].economic_regions` | String | 是 | 经济区划 |  |
| `data.credit_levels_list[].special_area` | String | 是 | 特殊贸易区域 |  |
| `data.credit_levels_list[].industry_type` | String | 是 | 行业种类 |  |
| `data.credit_levels_list[].vail_date` | String | 是 | 报关有效期 |  |
| `data.credit_levels_list[].elect_type` | String | 是 | 跨境贸易电子商务类型 |  |
| `data.credit_levels_list[].cancel_flag` | String | 是 | 海关注销标志 |  |
| `data.credit_levels_list[].annual_report` | String | 是 | 年报情况 |  |
| `data.credit_levels_list[].eid` | String | 是 | 企业id |  |
| `data.credit_levels_list[].first_record_date` | String | 是 | 最早备案日期 |  |
| `data.credit_levels_list[].new_record_date` | String | 是 | 最新备案日期 |  |
| `data.credit_levels_list[].is_history` | String | 是 | 0正常；1历史 |  |
| `data.taxrating_list` | Array | 是 | 纳税评级信息 |  |
| `data.taxrating_list[].level` | String | 是 | 评级等级 |  |
| `data.taxrating_list[].year` | String | 是 | 获得年份 |  |
| `data.taxrating_list[].agency` | String | 是 | 评级单位 |  |
| `data.taxrating_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.license_list` | Array | 是 | 行政许可信息 |  |
| `data.license_list[].name` | String | 是 | 许可文件名称 |  |
| `data.license_list[].number` | String | 是 | 许可文件编号 |  |
| `data.license_list[].start_date` | String | 是 | 有效期自 |  |
| `data.license_list[].end_date` | String | 是 | 有效期至 |  |
| `data.license_list[].department` | String | 是 | 许可机关 |  |
| `data.license_list[].content` | String | 是 | 许可内容 |  |
| `data.license_list[].status` | String | 是 | 状态 |  |
| `data.license_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.abnormal_list` | Array | 是 | 经营异常 |  |
| `data.abnormal_list[].in_date` | String | 是 | 列入日期 |  |
| `data.abnormal_list[].department` | String | 是 | 做出决定机关（列入） |  |
| `data.abnormal_list[].in_reason` | String | 是 | 列入经营异常名录原因 |  |
| `data.abnormal_list[].out_date` | String | 是 | 移出日期 |  |
| `data.abnormal_list[].out_department` | String | 是 | 做出决定机关（移出） |  |
| `data.abnormal_list[].out_reason` | String | 是 | 移出经营异常名录原因 |  |
| `data.abnormal_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.serious_illegal_list` | Array | 是 | 严重违法失信 |  |
| `data.serious_illegal_list[].ill_type` | String | 是 | 违法类别 |  |
| `data.serious_illegal_list[].in_reason` | String | 是 | 列入原因 |  |
| `data.serious_illegal_list[].in_date` | String | 是 | 列入日期 |  |
| `data.serious_illegal_list[].in_department` | String | 是 | 做出决定机关（列入） |  |
| `data.serious_illegal_list[].out_reason` | String | 是 | 移出原因 |  |
| `data.serious_illegal_list[].out_date` | String | 是 | 移出日期 |  |
| `data.serious_illegal_list[].out_department` | String | 是 | 做出决定机关（移出） |  |
| `data.serious_illegal_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.cases_list` | Array | 是 | 立案信息 |  |
| `data.cases_list[].case_no` | String | 是 | 案号 |  |
| `data.cases_list[].related_companies` | Array | 是 | 当事人 |  |
| `data.cases_list[].related_companies[].type` | String | 是 | 当事人类型 |  |
| `data.cases_list[].related_companies[].item` | String | 是 | 当事人id |  |
| `data.cases_list[].related_companies[].name` | String | 是 | 当事人姓名 |  |
| `data.cases_list[].related_companies[].role` | String | 是 | 当事人角色 |  |
| `data.cases_list[].related_companies[].clean_role` | String | 是 | 清洗后角色 |  |
| `data.cases_list[].case_cause` | String | 是 | 案由 |  |
| `data.cases_list[].start_date` | String | 是 | 立案时间 |  |
| `data.cases_list[].hearing_date` | String | 是 | 开庭时间 |  |
| `data.cases_list[].end_date` | String | 是 | 结束时间 |  |
| `data.cases_list[].case_status` | String | 是 | 案件状态 |  |
| `data.cases_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.hearing_notices_list` | Array | 是 | 开庭公告列表 |  |
| `data.hearing_notices_list[].case_no` | String | 是 | 案号 |  |
| `data.hearing_notices_list[].pure_role` | String | 是 | 身份 |  |
| `data.hearing_notices_list[].related_companies` | Array | 是 | 当事人 |  |
| `data.hearing_notices_list[].related_companies[].role` | String | 是 | 当事人角色 |  |
| `data.hearing_notices_list[].related_companies[].pure_role` | String | 是 | 角色 |  |
| `data.hearing_notices_list[].related_companies[].item` | String | 是 | 当事人id |  |
| `data.hearing_notices_list[].related_companies[].name` | String | 是 | 当事人姓名 |  |
| `data.hearing_notices_list[].related_companies[].type` | String | 是 | 当事人类型 |  |
| `data.hearing_notices_list[].hearing_date` | String | 是 | 开庭时间 |  |
| `data.hearing_notices_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.hearing_notices_list[].cause_action` | String | 是 | 案由 |  |
| `data.court_notices_list` | Array | 是 | 法院公告列表 |  |
| `data.court_notices_list[].type` | String | 是 | 公告类型 |  |
| `data.court_notices_list[].role` | String | 是 | 身份 |  |
| `data.court_notices_list[].people` | String | 是 | 当事人 |  |
| `data.court_notices_list[].date` | String | 是 | 发布时间 |  |
| `data.court_notices_list[].content` | String | 是 | 公告内容 |  |
| `data.court_notices_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.send_notices_list` | Array | 是 | 送达公告 |  |
| `data.send_notices_list[].case_no` | String | 是 | 案号 |  |
| `data.send_notices_list[].case_reason` | String | 是 | 案由 |  |
| `data.send_notices_list[].related_companies` | Array | 是 | 当事人 |  |
| `data.send_notices_list[].date` | String | 是 | 发布日期 |  |
| `data.send_notices_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.send_notices_list[].content` | String | 是 | 内容 |  |
| `data.judgement_list` | Array | 是 | 裁判文书列表 |  |
| `data.judgement_list[].doc_type` | String | 是 | 文书类型 |  |
| `data.judgement_list[].clean_role` | String | 是 | 案件身份 |  |
| `data.judgement_list[].trial_result` | String | 是 | 审判结果 |  |
| `data.judgement_list[].title` | String | 是 | 案件名称 |  |
| `data.judgement_list[].case_reasons` | String | 是 | 案由 |  |
| `data.judgement_list[].related_companies` | String | 是 | 身份 |  |
| `data.judgement_list[].related_companies.item` | String | 是 | id |  |
| `data.judgement_list[].related_companies.trial_result` | String | 是 | 结果 |  |
| `data.judgement_list[].related_companies.name` | String | 是 | 名称 |  |
| `data.judgement_list[].related_companies.role` | String | 是 | 角色 |  |
| `data.judgement_list[].related_companies.clean_role` | String | 是 | 清洗后角色 |  |
| `data.judgement_list[].related_companies.by` | String | 是 | 方式 |  |
| `data.judgement_list[].related_companies.type` | String | 是 | 类型 |  |
| `data.judgement_list[].date` | String | 是 | 判决时间 |  |
| `data.judgement_list[].standard_case_no` | String | 是 | 案号 |  |
| `data.judgement_list[].judgeresult` | String | 是 | 结果 |  |
| `data.judgement_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.enforcement_list` | Array | 是 | 被执行人列表 |  |
| `data.enforcement_list[].standard_case_no` | String | 是 | 案号 |  |
| `data.enforcement_list[].amount` | String | 是 | 执行标的 |  |
| `data.enforcement_list[].court_name` | String | 是 | 执行法院 |  |
| `data.enforcement_list[].case_date` | String | 是 | 立案时间 |  |
| `data.enforcement_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.executions_list` | Array | 是 | 失信信息列表 |  |
| `data.executions_list[].case_number` | String | 是 | 案号 |  |
| `data.executions_list[].doc_number` | String | 是 | 执行根据文号 |  |
| `data.executions_list[].amount` | String | 是 | 执行标的 |  |
| `data.executions_list[].date` | String | 是 | 立案时间 |  |
| `data.executions_list[].publish_date` | String | 是 | 发布日期 |  |
| `data.executions_list[].court` | String | 是 | 执行法院 |  |
| `data.executions_list[].execution_status` | String | 是 | 被执行人情况 |  |
| `data.executions_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.judicial_freeze_list` | Array | 是 | 股权冻结列表 |  |
| `data.judicial_freeze_list[].detail_notice_no` | String | 是 | 执行通知书文号 |  |
| `data.judicial_freeze_list[].be_executed_person` | String | 是 | 被执行人 |  |
| `data.judicial_freeze_list[].object_company` | String | 是 | 冻结股权的标的企业 |  |
| `data.judicial_freeze_list[].amount` | String | 是 | 股权数额 |  |
| `data.judicial_freeze_list[].executive_court` | String | 是 | 执行法院 |  |
| `data.judicial_freeze_list[].start_date` | String | 是 | 开始日期 |  |
| `data.judicial_freeze_list[].end_date` | String | 是 | 结束日期 |  |
| `data.judicial_freeze_list[].detail_public_date` | String | 是 | 公示日期 |  |
| `data.restricted_consumer_list` | Array | 是 | 限制高消费列表 |  |
| `data.restricted_consumer_list[].standard_case_no` | String | 是 | 案号 |  |
| `data.restricted_consumer_list[].case_reason` | String | 是 | 案由 |  |
| `data.restricted_consumer_list[].court` | String | 是 | 执行法院 |  |
| `data.restricted_consumer_list[].filing_date` | String | 是 | 立案时间 |  |
| `data.restricted_consumer_list[].release_date` | String | 是 | 限制令发布日期 |  |
| `data.restricted_consumer_list[].is_history` | String | 是 |  |  |
| `data.exit_limitation_list` | Array | 是 | 限制出境 |  |
| `data.exit_limitation_list[].standard_case_no` | String | 是 | 案号 |  |
| `data.exit_limitation_list[].pname` | String | 是 | 限制出境对象 |  |
| `data.exit_limitation_list[].ename` | String | 是 | 被执行人 |  |
| `data.exit_limitation_list[].amount` | String | 是 | 执行标的 |  |
| `data.exit_limitation_list[].publish_date` | String | 是 | 发布日期 |  |
| `data.exit_limitation_list[].url` | String | 是 | 内容 | 🔗 |
| `data.exit_limitation_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.terminationcaseitem_list` | Array | 是 | 终本案件列表 |  |
| `data.terminationcaseitem_list[].case_no_terminal` | String | 是 | 案号 |  |
| `data.terminationcaseitem_list[].name` | String | 是 | 被执行人 |  |
| `data.terminationcaseitem_list[].court` | String | 是 | 执行法院 |  |
| `data.terminationcaseitem_list[].filing_date` | String | 是 | 立案时间 |  |
| `data.terminationcaseitem_list[].terminate_date` | String | 是 | 终本时间 |  |
| `data.terminationcaseitem_list[].amount` | String | 是 | 执行标的（元） |  |
| `data.terminationcaseitem_list[].fail_perform_amount` | String | 是 | 未履行金额（元） |  |
| `data.terminationcaseitem_list[].status` | String | 是 | 履行状态（0：未知；1：已履行；2：未履行完毕） |  |
| `data.terminationcaseitem_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.auctions_list` | Array | 是 | 司法拍卖列表 |  |
| `data.auctions_list[].date` | String | 是 | 拍卖日期 |  |
| `data.auctions_list[].full_name` | String | 是 | 拍卖标的 |  |
| `data.auctions_list[].start_price` | String | 是 | 起拍价 |  |
| `data.auctions_list[].description` | String | 是 | 拍品介绍 |  |
| `data.administrative_punishment_list` | Array | 是 | 行政处罚列表 |  |
| `data.administrative_punishment_list[].number` | String | 是 | 行政处罚决定书文号 |  |
| `data.administrative_punishment_list[].illegal_type` | String | 是 | 违法行为类型 |  |
| `data.administrative_punishment_list[].content` | String | 是 | 行政处罚内容 |  |
| `data.administrative_punishment_list[].punish_amount` | String | 是 | 罚款金额 |  |
| `data.administrative_punishment_list[].district_name` | String | 是 | 作出行政处罚决定机关名称 |  |
| `data.administrative_punishment_list[].date` | String | 是 | 作出行政处罚决定日期 |  |
| `data.administrative_punishment_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.environment_punishment_list` | Array | 是 | 环保处罚 |  |
| `data.environment_punishment_list[].punish_date` | String | 是 | 处罚日期 |  |
| `data.environment_punishment_list[].document_no` | String | 是 | 决定文书号 |  |
| `data.environment_punishment_list[].illegal_type` | String | 是 | 违法行为类型 |  |
| `data.environment_punishment_list[].punishment_result` | String | 是 | 处罚内容 |  |
| `data.environment_punishment_list[].punish_amnt` | String | 是 | 罚款金额 |  |
| `data.environment_punishment_list[].standard_dep` | String | 是 | 做出处罚决定机关 |  |
| `data.environment_punishment_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.labor_arbitration_list` | Array | 是 | 劳动仲裁 |  |
| `data.labor_arbitration_list[].case_no` | String | 是 | 案号 |  |
| `data.labor_arbitration_list[].case_reason` | String | 是 | 案由 |  |
| `data.labor_arbitration_list[].hearing_date` | String | 是 | 开庭日期 |  |
| `data.labor_arbitration_list[].department` | String | 是 | 发布机构 |  |
| `data.labor_arbitration_list[].related_companies` | Array | 是 | 当事人 |  |
| `data.labor_arbitration_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.labor_arbitration_list[].release_time` | String | 是 | 发布日期 |  |
| `data.black_list` | Array | 是 | 黑名单 |  |
| `data.black_list[].lists_type` | String | 是 | 黑名单类型(01政府黑名单 02环保失信黑名单 03应急管理部安全生产失信黑名单 04政府采购黑名单 05“屡禁不止、屡罚不改”黑名单 06 其他 07 假冒国企名单 08 军队采购失信名单 09 政府采购失信名单 10 供应商暂停名单 11 社会组织活动异常名录 12 社会组织严重违法失信名单 13 涉金融领域黑名单 14 价格招采信用评价失信名单） |  |
| `data.black_list[].black_basis` | String | 是 | 黑名单认定依据 |  |
| `data.black_list[].maintain_department` | String | 是 | 认定部门 |  |
| `data.black_list[].department_level` | String | 是 | 认定等级（根据发布机关所属行政等级区分，枚举值为01国家级 02省级 03市级 04县级 05乡级 06其他） |  |
| `data.black_list[].in_lists_date` | String | 是 | 列入日期 |  |
| `data.black_list[].details` | String | 是 | 内容 |  |
| `data.black_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.black_list[].punishment_result` | String | 是 | 处罚结果 |  |
| `data.bankruptcy_list` | Array | 是 | 破产案件 |  |
| `data.bankruptcy_list[].standard_case_no` | String | 是 | 案号 |  |
| `data.bankruptcy_list[].case_kind` | String | 是 | 案件类型(1破产审查案件、2破产案件、6破产上诉案件、7破产监督案件为破产案件，3强制清算申请审查案件、4强制清算案件、5强制清算上诉案件、8强制清算监督案件为强制清算) |  |
| `data.bankruptcy_list[].court` | String | 是 | 经办法院 |  |
| `data.bankruptcy_list[].name` | String | 是 | 被申请人 |  |
| `data.bankruptcy_list[].app_name` | String | 是 | 申请人 |  |
| `data.bankruptcy_list[].pub_date` | String | 是 | 公开日期 |  |
| `data.bankruptcy_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.clear_account_list` | Array | 是 | 清算信息 |  |
| `data.clear_account_list[].leader` | String | 是 | 清算组负责人 |  |
| `data.clear_account_list[].employees` | String | 是 | 清算组成员 |  |
| `data.equityquality_list` | Array | 是 | 股权出质列表 |  |
| `data.equityquality_list[].date` | String | 是 | 登记日期 |  |
| `data.equityquality_list[].number` | String | 是 | 登记编号 |  |
| `data.equityquality_list[].pledgor` | String | 是 | 出质人 |  |
| `data.equityquality_list[].pawnee` | String | 是 | 质权人 |  |
| `data.equityquality_list[].object_company` | String | 是 | 标的方 |  |
| `data.equityquality_list[].status` | String | 是 | 状态 |  |
| `data.equityquality_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.mortages_list` | Array | 是 | 动产抵押 |  |
| `data.mortages_list[].number` | String | 是 | 登记编号 |  |
| `data.mortages_list[].department` | String | 是 | 登记机关 |  |
| `data.mortages_list[].guarantees` | String | 是 | 抵押物 |  |
| `data.mortages_list[].type` | String | 是 | 被担保债权种类 |  |
| `data.mortages_list[].amount` | String | 是 | 被担保债权数额 |  |
| `data.mortages_list[].status` | String | 是 | 状态 |  |
| `data.mortages_list[].date` | String | 是 | 登记日期 |  |
| `data.mortages_list[].period` | String | 是 | 债务人履行债务的期限 |  |
| `data.mortages_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.overduetaxs_list` | Array | 是 | 欠税信息 |  |
| `data.overduetaxs_list[].taxpayer_num` | String | 是 | 纳税人识别号 |  |
| `data.overduetaxs_list[].overdue_type` | String | 是 | 欠税税种 |  |
| `data.overduetaxs_list[].overdue_amount` | String | 是 | 欠税金额 |  |
| `data.overduetaxs_list[].curr_overdue_amount` | String | 是 | 当前新发生的欠税额 |  |
| `data.overduetaxs_list[].pub_date` | String | 是 | 发布时间 |  |
| `data.overduetaxs_list[].pub_department` | String | 是 | 发布单位 |  |
| `data.overduetaxs_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.huge_tax_punishment_list` | Array | 是 | 重大税收违法 |  |
| `data.huge_tax_punishment_list[].time` | String | 是 | 发布时间 |  |
| `data.huge_tax_punishment_list[].pub_department` | String | 是 | 所属税务机关 |  |
| `data.huge_tax_punishment_list[].case_type` | String | 是 | 案件性质 |  |
| `data.huge_tax_punishment_list[].url` | String | 是 | 详情 | 🔗 |
| `data.huge_tax_punishment_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.abnormal_enterprises_list` | Array | 是 | 非正常户 |  |
| `data.abnormal_enterprises_list[].judge_date` | String | 是 | 认定日期 |  |
| `data.abnormal_enterprises_list[].tax_num` | String | 是 | 纳税人识别号 |  |
| `data.abnormal_enterprises_list[].overdue_type` | String | 是 | 欠税税种 |  |
| `data.abnormal_enterprises_list[].overdue_amount` | String | 是 | 欠税金额 |  |
| `data.abnormal_enterprises_list[].judge_department` | String | 是 | 认定单位 |  |
| `data.abnormal_enterprises_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.knowledge_properites_list` | Array | 是 | 知识产权出质 |  |
| `data.knowledge_properites_list[].name` | String | 是 | 名称 |  |
| `data.knowledge_properites_list[].pledgor` | String | 是 | 出质人 |  |
| `data.knowledge_properites_list[].pawnee` | String | 是 | 质权人 |  |
| `data.knowledge_properites_list[].status` | String | 是 | 状态 |  |
| `data.knowledge_properites_list[].public_date` | String | 是 | 公示日期 |  |
| `data.knowledge_properites_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.simple_cancellation_list` | Array | 是 | 简易注销 |  |
| `data.simple_cancellation_list[].name` | String | 是 | 企业名称 |  |
| `data.simple_cancellation_list[].notice_period_start` | String | 是 | 公示开始日期 |  |
| `data.simple_cancellation_list[].notice_period_end` | String | 是 | 公示结束日期 |  |
| `data.simple_cancellation_list[].result` | String | 是 | 简易注销结果 |  |
| `data.simple_cancellation_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.logout_announcement_list` | Array | 是 | 注销备案 |  |
| `data.logout_announcement_list[].audit_reg_date` | String | 是 | 清算组备案日期 |  |
| `data.logout_announcement_list[].creditor_start_date` | String | 是 | 债权人公告开始日期 |  |
| `data.logout_announcement_list[].creditor_end_date` | String | 是 | 债权人公告结束日期 |  |
| `data.logout_announcement_list[].logout_reason` | String | 是 | 注销原因 |  |
| `data.logout_announcement_list[].status` | String | 是 | 状态(2：已撤销，非2：已发布) |  |
| `data.logout_announcement_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.bidding_limitation_list` | Array | 是 | 限制招投标 |  |
| `data.bidding_limitation_list[].case_no` | String | 是 | 案号 |  |
| `data.bidding_limitation_list[].case_reason` | String | 是 | 执行案由 |  |
| `data.bidding_limitation_list[].amount` | String | 是 | 执行标的 |  |
| `data.bidding_limitation_list[].unexecuted_amount` | String | 是 | 未执行金额（元） |  |
| `data.bidding_limitation_list[].publish_date` | String | 是 | 发布日期 |  |
| `data.bidding_limitation_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |

### 36.99 企业信用全景报告-获取报告

- Hub：`POST /api/v1/data/enterprise/36.99/query`；上游方法 GET；可调用
- 说明：通过55.82获取的report_id，查询报告文件

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `report_id` | String | 是 | 报告 id |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.report_id` | String | 是 | 报告id |  |
| `data.name` | String | 是 | 企业名称 |  |
| `data.report_pdf` | String | 是 | pdf版报告链接 | 🔗 |

### 35.86 董监高信息洞察报告-JOB申请

- Hub：`POST /api/v1/data/enterprise/35.86/query`；上游方法 GET；**不可调用**（无公开价，返回 403 `enterprise_price_negotiated`）
- 说明：对企业法人、股东、高管人员进行全面查询，提供投资与任职、知识产权、风险等信息。通过report_id查询 22.62获取报告文件

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `p_name` | String | 是 | 人员姓名 |
| `time_range` | Number | 否 | 数据范围（1.近1年 3.近3年 5.近5年 0.全部 默认1） |
| `dimension` | String | 否 | 报告返回内容，默认返回所有。支持输入序号对应的内容，多个序号用英文逗号连接，如1,2,3,4 |
| `include_history` | Number | 否 | 是否查询历史数据，默认为0。枚举：0 当前最新数据，1 全部数据（包含历史） |
| `report_format` | String | 否 | 报告形式：0 json ，1 文件，仅单选，默认为1 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 |  |  |
| `data.company` | String | 是 | 企业名称，若report_format=1； |  |
| `data.p_name` | String | 是 | 人员名称 |  |
| `data.report_id` | String | 是 | 报告 id |  |
| `data.person_info` | Object | 是 | 人员概览，若report_format=0 |  |
| `data.person_info.pname` | String | 是 | 姓名 |  |
| `data.person_info.company` | String | 是 | 所在公司 |  |
| `data.person_info.type` | String | 是 | 所任职位 |  |
| `data.person_info.brief` | String | 是 | 个人介绍 |  |
| `data.person_info.info_overview` | Object | 是 | 人员信息概览 |  |
| `data.person_info.info_overview.person_count` | String | 是 | 人员基本信息数量 |  |
| `data.person_info.info_overview.intellectual_count` | String | 是 | 知识产权数量 |  |
| `data.person_info.info_overview.risk_count` | String | 是 | 人员自身风险数量 |  |
| `data.person_info.info_overview.related_enterprise_risk` | String | 是 | 关联企业风险数量 |  |
| `data.oper_list` | Array | 是 | 担任法人的企业 |  |
| `data.oper_list[].name` | String | 是 | 法定代表人 |  |
| `data.oper_list[].company` | String | 是 | 企业名称 |  |
| `data.oper_list[].credit_no` | String | 是 | 企业统一社会信用代码/注册号 |  |
| `data.oper_list[].regist_date` | String | 是 | 企业注册日期 |  |
| `data.oper_list[].company_type` | String | 是 | 企业类型 |  |
| `data.oper_list[].company_status` | String | 是 | 企业经营状态 |  |
| `data.oper_list[].regist_capi` | String | 是 | 企业注册资本 |  |
| `data.oper_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.stockholder_list` | Array | 是 | 担任股东的企业 |  |
| `data.stockholder_list[].name` | String | 是 | 自然人名称 |  |
| `data.stockholder_list[].company` | String | 是 | 企业名称 |  |
| `data.stockholder_list[].credit_no` | String | 是 | 企业统一社会信用代码/注册号 |  |
| `data.stockholder_list[].company_type` | String | 是 | 企业类型 |  |
| `data.stockholder_list[].company_status` | String | 是 | 企业经营状态 |  |
| `data.stockholder_list[].regist_capi` | String | 是 | 企业注册资本 |  |
| `data.stockholder_list[].regist_date` | String | 是 | 企业注册日期 |  |
| `data.stockholder_list[].should_capi` | String | 是 | 认缴出资 |  |
| `data.stockholder_list[].percent` | String | 是 | 出资比例 |  |
| `data.stockholder_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.manager_list` | Array | 是 | 担任高管的企业 |  |
| `data.manager_list[].name` | String | 是 | 自然人名称 |  |
| `data.manager_list[].company` | String | 是 | 企业名称 |  |
| `data.manager_list[].credit_no` | String | 是 | 企业统一社会信用代码/注册号 |  |
| `data.manager_list[].regist_date` | String | 是 | 企业注册日期 |  |
| `data.manager_list[].company_type` | String | 是 | 企业类型 |  |
| `data.manager_list[].company_status` | String | 是 | 企业经营状态 |  |
| `data.manager_list[].regist_capi` | String | 是 | 企业注册资本 |  |
| `data.manager_list[].title` | String | 是 | 职务 |  |
| `data.manager_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.investment_list` | Array | 是 | 控股企业 |  |
| `data.investment_list[].invest_name` | String | 是 | 被投资企业名称 |  |
| `data.investment_list[].invest_eid` | String | 是 | 被投资企业eid |  |
| `data.investment_list[].invest_oper_name` | String | 是 | 被投资企业法定代表人 |  |
| `data.investment_list[].invest_credit_no` | String | 是 | 被投资企业统一社会信用代码 |  |
| `data.investment_list[].invest_status` | String | 是 | 被投资企业状态 |  |
| `data.investment_list[].invest_start_date` | String | 是 | 被投资企业成立日期 |  |
| `data.investment_list[].invest_percent` | String | 是 | 总投资比例 |  |
| `data.investment_list[].direct_percent` | String | 是 | 直接投资比例 |  |
| `data.investment_list[].invest_level` | String | 是 | 最短投资层级 |  |
| `data.investment_list[].invest_desc` | String | 是 | 投资描述 |  |
| `data.investment_list[].invest_relationship_path` | String | 是 | 投资路径 |  |
| `data.investment_list[].end_date` | String | 是 | 历史投资退出日期 |  |
| `data.investment_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.actual_controller_list` | Array | 是 | 实控企业 |  |
| `data.actual_controller_list[].control_ename` | String | 是 | 实控企业名称 |  |
| `data.actual_controller_list[].total_percent` | String | 是 | 持股比例 |  |
| `data.actual_controller_list[].control_credit_no` | String | 是 | 实控企业统一社会信用代码 |  |
| `data.actual_controller_list[].control_path` | String | 是 | 实控人路径 |  |
| `data.actual_controller_list[].control_status` | String | 是 | 实控企业状态 |  |
| `data.actual_controller_list[].control_regist_capi` | String | 是 | 实控企业注册资本 |  |
| `data.actual_controller_list[].control_oper_name` | String | 是 | 实控企业法定代表人 |  |
| `data.actual_controller_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.partners_list` | Array | 是 | 合作伙伴 |  |
| `data.partners_list[].pname` | String | 是 | 合作伙伴姓名 |  |
| `data.partners_list[].cname` | String | 是 | 任职企业 |  |
| `data.partners_list[].start_date` | String | 是 | 企业注册日期 |  |
| `data.partners_list[].status` | String | 是 | 经营状态 |  |
| `data.partners_list[].job_title` | String | 是 | 职位 |  |
| `data.partners_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.patent_list` | Array | 是 | 专利信息 |  |
| `data.patent_list[].pname` | String | 是 | 姓名 |  |
| `data.patent_list[].id` | String | 是 | 申请号 |  |
| `data.patent_list[].type` | String | 是 | 专利类型 |  |
| `data.patent_list[].number` | String | 是 | 授权公告号 |  |
| `data.patent_list[].u_date2` | String | 是 | 授权公告日 |  |
| `data.patent_list[].u_name` | String | 是 | 专利标题 |  |
| `data.patent_list[].u_brief` | String | 是 | 专利摘要 |  |
| `data.restricted_consumer_list` | Array | 是 | 限制高消费 |  |
| `data.restricted_consumer_list[].case_no` | String | 是 | 案号 |  |
| `data.restricted_consumer_list[].court` | String | 是 | 执行法院 |  |
| `data.restricted_consumer_list[].case_reason` | String | 是 | 案由 |  |
| `data.restricted_consumer_list[].filing_date` | String | 是 | 立案时间 |  |
| `data.restricted_consumer_list[].release_date` | String | 是 | 限制令发布日期 |  |
| `data.restricted_consumer_list[].content` | String | 是 | 内容 |  |
| `data.restricted_consumer_list[].source` | String | 是 | 地址 |  |
| `data.restricted_consumer_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.judicial_freeze_list` | Array | 是 | 股权冻结 |  |
| `data.judicial_freeze_list[].name` | string | 是 | 被执行人 |  |
| `data.judicial_freeze_list[].company_name` | string | 是 | 冻结股权标的企业 |  |
| `data.judicial_freeze_list[].number` | string | 是 | 执行通知书文号 |  |
| `data.judicial_freeze_list[].amount` | string | 是 | 股权数额 |  |
| `data.judicial_freeze_list[].executive_court` | string | 是 | 执行法院 |  |
| `data.judicial_freeze_list[].status` | string | 是 | 类型/状态 |  |
| `data.judicial_freeze_list[].detail_freeze_start_date` | string | 是 | 股权冻结开始时间 |  |
| `data.judicial_freeze_list[].detail_freeze_end_date` | string | 是 | 股权冻结结束时间 |  |
| `data.judicial_freeze_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.equity_pledge_list` | Array | 是 | 股权出质 |  |
| `data.equity_pledge_list[].pledgor` | string | 是 | 出质人 |  |
| `data.equity_pledge_list[].pawnee` | string | 是 | 质权人 |  |
| `data.equity_pledge_list[].number` | string | 是 | 登记编号 |  |
| `data.equity_pledge_list[].object_company` | string | 是 | 出质股权标的企业 |  |
| `data.equity_pledge_list[].pledgor_amount` | string | 是 | 出质股权数额（万元） |  |
| `data.equity_pledge_list[].date` | string | 是 | 登记日期 |  |
| `data.equity_pledge_list[].status` | string | 是 | 状态 |  |
| `data.equity_pledge_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.equity_mortgage_list` | Array | 是 | 股权质押 |  |
| `data.equity_mortgage_list[].noticedate` | String | 是 | 公告日期 |  |
| `data.equity_mortgage_list[].p_name` | String | 是 | 人员姓名 |  |
| `data.equity_mortgage_list[].frozentype` | String | 是 | 质押冻结类型 |  |
| `data.equity_mortgage_list[].sharetype` | String | 是 | 质押股份类型 |  |
| `data.equity_mortgage_list[].frozenstartdate` | String | 是 | 质押/冻结起始日 |  |
| `data.equity_mortgage_list[].freedate` | String | 是 | 质押/冻结截止日 |  |
| `data.equity_mortgage_list[].ghdate` | String | 是 | 过户日期 |  |
| `data.equity_mortgage_list[].freedtaeinad` | String | 是 | 实际解除日期 |  |
| `data.equity_mortgage_list[].frozenname` | String | 是 | 实施质押冻结机构 |  |
| `data.equity_mortgage_list[].frozeneid` | String | 是 | 质押冻结机构代码 |  |
| `data.equity_mortgage_list[].invamount` | String | 是 | 涉及金额 |  |
| `data.equity_mortgage_list[].sharehdnum` | String | 是 | 所持股数（万股） |  |
| `data.equity_mortgage_list[].achgshare` | String | 是 | 变动后股数 |  |
| `data.equity_mortgage_list[].sharefrozennum` | String | 是 | 质押/冻结股数（万股） |  |
| `data.equity_mortgage_list[].noreleasnum` | String | 是 | 剩余未解押数 |  |
| `data.equity_mortgage_list[].amtsharefrozen` | String | 是 | 累计质押股数（万股） |  |
| `data.equity_mortgage_list[].frozenratio` | String | 是 | 质押/冻结占所持股比例 |  |
| `data.equity_mortgage_list[].frozenintotal` | String | 是 | 质押/冻结占总股本比例 |  |
| `data.equity_mortgage_list[].achgratio` | String | 是 | 变动后股数占总股本比例 |  |
| `data.equity_mortgage_list[].amtsharerepo` | String | 是 | 累计质押/约定回购股数（万股） |  |
| `data.equity_mortgage_list[].amtshratio` | String | 是 | 累计质押数占所持股比例 |  |
| `data.equity_mortgage_list[].amtfrozenratio` | String | 是 | -累计质押股数占总股本比例 |  |
| `data.equity_mortgage_list[].amtreporatio` | String | 是 | 累计质押/约定回购股数占总股本比例 |  |
| `data.equity_mortgage_list[].ndateamtsharerepo` | String | 是 | 截止公告日累计质押数（股） |  |
| `data.equity_mortgage_list[].ndateamtshatoeqra` | String | 是 | 截止公告日累计质押数占总股本比例 |  |
| `data.equity_mortgage_list[].ndateamtshratio` | String | 是 | 截止公告日累计质押数占所持股比例 |  |
| `data.equity_mortgage_list[].frozendateexplain` | String | 是 | 质押/冻结期限描述 |  |
| `data.equity_mortgage_list[].pledgepur` | String | 是 | 质押目的（"001贷款 002担保 003授信额度"） |  |
| `data.equity_mortgage_list[].meunfrpled` | String | 是 | 解除质押冻结方式 |  |
| `data.equity_mortgage_list[].frozprogres` | String | 是 | 质押冻结进度（初始质押 初始质押回购 初始约定回购 初始冻结 初始托管 轮候冻结 补充质押 预计解除 到期解除 部分解除） |  |
| `data.equity_mortgage_list[].relinfocode` | String | 是 | 公告编码 |  |
| `data.equity_mortgage_list[].frozenreason` | String | 是 | 质押/冻结事由 |  |
| `data.equity_mortgage_list[].remark` | String | 是 | 备注 |  |
| `data.equity_mortgage_list[].is_history` | String | 是 | 是否历史（0：否 1：是） |  |
| `data.judgement_list` | Array | 是 | 裁判文书 |  |
| `data.judgement_list[].name` | String | 是 | 企业名称 |  |
| `data.judgement_list[].position` | String | 是 | 投资及任职关系 |  |
| `data.judgement_list[].num` | Number | 是 | 数量 |  |
| `data.enforcement_list` | Array | 是 | 被执行人 |  |
| `data.enforcement_list[].name` | String | 是 | 企业名称 |  |
| `data.enforcement_list[].position` | String | 是 | 投资及任职关系 |  |
| `data.enforcement_list[].num` | Number | 是 | 数量 |  |
| `data.execution_list` | Array | 是 | 失信信息 |  |
| `data.execution_list[].name` | String | 是 | 企业名称 |  |
| `data.execution_list[].position` | String | 是 | 投资及任职关系 |  |
| `data.execution_list[].num` | Number | 是 | 数量 |  |
| `data.consumption_restriction_list` | Array | 是 | 限制高消费 |  |
| `data.consumption_restriction_list[].name` | String | 是 | 企业名称 |  |
| `data.consumption_restriction_list[].position` | String | 是 | 投资及任职关系 |  |
| `data.consumption_restriction_list[].num` | Number | 是 | 数量 |  |
| `data.final_case_list` | Array | 是 | 终本案件 |  |
| `data.final_case_list[].name` | String | 是 | 企业名称 |  |
| `data.final_case_list[].position` | String | 是 | 投资及任职关系 |  |
| `data.final_case_list[].num` | Number | 是 | 数量 |  |

### 22.62 董监高信息洞察报告-获取报告

- Hub：`POST /api/v1/data/enterprise/22.62/query`；上游方法 GET；可调用
- 说明：通过35.86获取的report_id，查询报告文件

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `report_id` | String | 是 | 报告 id |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.report_id` | String | 是 | 报告id |  |
| `data.name` | String | 是 | 企业名称 |  |
| `data.p_name` | String | 是 | 人员名称 |  |
| `data.report_pdf` | String | 是 | pdf版报告链接 | 🔗 |

## 搜索查询


### 1.31 企业模糊搜索

- Hub：`POST /api/v1/data/enterprise/1.31/query`；上游方法 GET；可调用
- 说明：根据关键词对企业进行模糊搜索

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业相关关键字，输入字数大于等于2个或以上，且不允许仅输入公司和有限公司 |
| `matchType` | String | 否 | 匹配类型（可选），keyword 需要匹配的 字段，可以输入以下一个或者几个类型， 多个类型使用,分隔： partner：股东 oper：法人 member：高管 contact：联系方式 scope：经营范围 ename：公司名称 patent：专利 copyright：著作权作品名称 software：软件著作权名称 trademark：商标 domain：网址 product：产品 |
| `region` | String | 否 | 地区编码（可选），输入参数为空返回全 部区域匹配记录。可传入 省/直辖市，城市，区县的国家区划码。 只支持传入一个区划码。 省/直辖市：传入国家区划码前两位数字， 如搜索“江苏省”则传入 32，各省/直辖 市编码可参考本文档附录 城市：传入国家区划码前四位数字，如搜 索“苏州市”，则传入 3205 区县：传入国家区划码六位数字，如搜索 “苏州市吴中区”，则传入 320506 可以通过下面网页查询国家区划编码https://www.mca.gov.cn/mzsj/xzqh/2022/202201xzqh.html |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回10条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 当前返回的条目数 |  |
| `data.items` | Array | 是 | 企业列表 |  |
| `data.items[].matchType` | String | 是 | 匹配类型 |  |
| `data.items[].name` | String | 是 | 企业名称 |  |
| `data.items[].reg_no` | String | 是 | 注册号 |  |
| `data.items[].start_date` | String | 是 | 成立日期 |  |
| `data.items[].oper_name` | String | 是 | 企业法定代表人 |  |
| `data.items[].credit_no` | String | 是 | 社会统一信用代码 |  |
| `data.items[].id` | String | 是 | 企业编号 |  |
| `data.items[].matchItems` | String | 是 | 匹配关键字 |  |
| `data.items[].type` | String | 是 | 企业类型，枚举值：，0企业，4社团，5律所，6香港公司，7非法社团：8台湾；9澳门 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 1.2 企业高级搜索

- Hub：`POST /api/v1/data/enterprise/1.2/query`；上游方法 GET；可调用
- 说明：根据企业名称关键字获取企业列表

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 关键字 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据，skip最大值为29980） |
| `method` | String | 否 | 搜索范围，多个使用逗号分隔，具体值参 考附录 |
| `org_type` | String | 否 | 组织类型，多个使用逗号分隔，具体值参 考附录 |
| `area_code` | String | 否 | 地区代码 |
| `industry_code` | String | 否 | 行业代码 |
| `econ_type` | String | 否 | 企业类型，多个使用逗号分隔，具体值参 考附录 |
| `capi_from` | String | 否 | 注册资本起（单位万，输入数值即可，例如100） |
| `capi_to` | String | 否 | 注册资本止（单位万，输入数值即可，例如1000） |
| `date_from` | String | 否 | 成立日期起（YYYY-mm-dd） |
| `date_to` | String | 否 | 成立日期止（YYYY-mm-dd） |
| `status` | String | 否 | 企业状态，多个使用逗号分隔，具体值参 考附录 |
| `canbao_from` | String | 否 | 参保人数起(单位人，输入数值即可，例如：20) |
| `canbao_to` | String | 否 | 参保人数止(单位人，输入数值即可，例如：200) |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 企业列表 |  |
| `data.items[].eid` | String | 是 | 企业 id |  |
| `data.items[].name` | String | 是 | 企业名称 |  |
| `data.items[].start_date` | String | 是 | 成立日期 |  |
| `data.items[].oper_name` | String | 是 | 企业法定代表人 |  |
| `data.items[].credit_no` | String | 是 | 社会统一信用代码 |  |
| `data.items[].reg_capi_desc` | String | 是 | 注册资本 |  |
| `data.items[].reg_no` | String | 是 | 注册号 |  |
| `data.items[].status` | String | 是 | 企业状态 |  |
| `data.items[].match_items` | Array | 是 | 匹配项列表 |  |
| `data.items[].match_items[].field` | String | 是 | 匹配项 |  |
| `data.items[].match_items[].value` | String | 是 | 匹配值 |  |
| `data.items[].category_new` | String | 是 | 企业分类(0115601:企业;0115602:个体;0115603:农民专业合作社;0115699:其他类型0215601:社会团体;0215602:基金会;0215603:民办非企业单位;0215604:村民/居民委员会;0215605:宗教，工会等其他社会组织;0315601:事业单位;0315602:机关;0315603:其他机构编制;0434401:香港企业;0444602:澳门企业;0415803:台湾企业;0499904:国外企业;0515601:律所;0500099:其他组织机构;) |  |
| `data.items[].reg_address` | String | 是 | 注册地址 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 21.92 招投标信息搜索

- Hub：`POST /api/v1/data/enterprise/21.92/query`；上游方法 GET；可调用
- 说明：招投标信息搜索，包括招投标ID、标题，招标单位、中标单位、以及其他与招投标项目相关的其他角色列表等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 搜索关键词 |
| `search_scope` | String | 否 | 搜索范围（默认全部），入参值参照附件枚举 |
| `notice_type` | String | 否 | 标讯类型（默认全部），入参值参照枚举 |
| `start_date` | String | 否 | 发布起始日期，格式为YYYY-MM-DD |
| `end_date` | String | 否 | 发布截至时间，格式为YYYY-MM-DD |
| `district_code` | String | 否 | 省份地区代码（默认全部），入参值参照枚举 |
| `project_type` | String | 否 | 项目分类（默认全部），入参值参照枚举 |
| `budget_amt_from` | String | 否 | 预算金额下限 |
| `budget_amt_to` | String | 否 | 预算金额上限 |
| `bid_amt_from` | String | 否 | 中标金额下限 |
| `bid_amt_to` | String | 否 | 中标金额上限 |
| `skip` | String | 否 | 跳过条目数（skip默认为0，最大490，每页条数为 10） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].title` | String | 是 | 标题 |  |
| `data.items[].id` | String | 是 | 招投标详情ID |  |
| `data.items[].notice_type` | String | 是 | 标讯类型 |  |
| `data.items[].date` | String | 是 | 发布日期 |  |
| `data.items[].district` | String | 是 | 省份地区 |  |
| `data.items[].project_type` | String | 是 | 项目类型 |  |
| `data.items[].budget_amt` | String | 是 | 预算金额，单位万 |  |
| `data.items[].bid_amt` | String | 是 | 中标金额，单位万 |  |
| `data.items[].tender` | Array | 是 | 招标单位列表 |  |
| `data.items[].tender[].name` | String | 是 | 招标机构名称 |  |
| `data.items[].tender[].eid` | String | 是 | 企业 id |  |
| `data.items[].tender[].contacts` | Array | 是 | 联系人 |  |
| `data.items[].tender[].phones` | Array | 是 | 联系手机号 |  |
| `data.items[].tender[].address` | Array | 是 | 联系地址 |  |
| `data.items[].tender[].email` | Array | 是 | 邮箱 |  |
| `data.items[].agency` | Array | 是 | 代理单位列表 |  |
| `data.items[].agency[].name` | String | 是 | 代理机构名称 |  |
| `data.items[].agency[].eid` | String | 是 | 企业 id |  |
| `data.items[].agency[].contacts` | Array | 是 | 联系人 |  |
| `data.items[].agency[].phones` | Array | 是 | 联系手机号 |  |
| `data.items[].agency[].address` | Array | 是 | 联系地址 |  |
| `data.items[].agency[].email` | Array | 是 | 邮箱 |  |
| `data.items[].winner` | Array | 是 | 中标单位列表 |  |
| `data.items[].winner[].name` | String | 是 | 中标机构名称 |  |
| `data.items[].winner[].eid` | String | 是 | 企业 id |  |
| `data.items[].winner[].project_bid_money` | String | 是 | 中标金额 |  |
| `data.items[].winner[].contacts` | Array | 是 | 联系人 |  |
| `data.items[].winner[].phones` | Array | 是 | 联系手机号 |  |
| `data.items[].winner[].address` | Array | 是 | 联系地址 |  |
| `data.items[].winner[].email` | Array | 是 | 邮箱 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 19.91 商标信息搜索

- Hub：`POST /api/v1/data/enterprise/19.91/query`；上游方法 GET；可调用
- 说明：根据商标名称/注册号/申请人搜索商标信息，包括注册号、国际分类号、专用权期限等。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 商标名称/注册号/申请人 |
| `match_type` | String | 否 | 匹配类型（可选），keyword 需要匹配的 字段，可以输入以下一个或者几个类型， 多个类型使用,分隔： trademark_name 商标名称；reg_number 注册号；applicant 申请人 |
| `date_from` | String | 否 | 申请日期起，格式为yyyy-mm-dd |
| `date_to` | String | 否 | 申请日期止，yyyy-mm-dd |
| `type_num` | String | 否 | 国际分类号，1 化学原料 2 颜料油漆 3 日化用品 4 染料油脂 5 医药 6 金属材料 7 机械设备 8 手工器械 9 科学仪器 10 医疗器械 11 灯具空调 12 运输工具 13 军火烟火 14 珠宝钟表 15 乐器 16 办公品 17 橡胶制品 18 皮革皮具 19 建筑材料 20 家具 21 厨房洁具 22 绳网袋篷 23 纱线丝 24 布料床单 25 服装鞋帽 26 纽扣拉链 27 地毯席垫 28 健身器材 29 食品 30 方便食品 31 饲料种籽 32 啤酒饮料 33 酒 34 烟草烟具 35 广告销售 36 金融物管 37 建筑修理 38 通讯服务 39 运输贮藏 40 材料加工 41 教育娱乐 42 设计研究 43 餐饮住宿 44 医疗园艺 45 社会法律 |
| `trademark_status_simplified` | String | 否 | 商标状态，已注册；商标被撤销；商标已失效；期满未续展；无效宣告审查中；商标被注销；等待实质审查；驳回复审；申请撤回；异议中；初审公告；其他 |
| `skip` | Number | 否 | 跳过条目数（skip默认为0，每页条数为20） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].reg_number` | String | 是 | 注册号 |  |
| `data.items[].object_id` | String | 是 | 商标id，object_id |  |
| `data.items[].trademark_name` | String | 是 | 商标名称 |  |
| `data.items[].type_num` | String | 是 | 国际分类号 |  |
| `data.items[].image_url` | String | 是 | 商标图片 | 🔗 |
| `data.items[].period` | String | 是 | 专用权期限 |  |
| `data.items[].apply_date` | String | 是 | 申请日期 |  |
| `data.items[].end_date` | String | 是 | 结束日期(专用权期限) |  |
| `data.items[].products` | Array | 是 | 商品/服务列表 |  |
| `data.items[].products[].product_group` | String | 是 | 类似群 |  |
| `data.items[].products[].product_name` | String | 是 | 商品名称 |  |
| `data.items[].applicant` | String | 是 | 申请人 |  |
| `data.items[].eid` | String | 是 | 企业id |  |
| `data.items[].agent_eid` | String | 是 | 代理信息 |  |
| `data.items[].category_flag` | String | 是 | 商标类型，0：普通商标；1：特殊商标；2：集体商标；3：证明商标 |  |
| `data.items[].trademark_status_simplified` | String | 是 | 商标状态 |  |
| `data.items[].is_history` | String | 是 | 是否历史 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

## 工商信息


### 1.41 工商照面

- Hub：`POST /api/v1/data/enterprise/1.41/query`；上游方法 GET；可调用
- 说明：企业工商照面及相关信息，包括统一社会信用代码、注册资本、经营范围、企业法定代表人等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.econKind` | String | 是 | 企业类型 |  |
| `data.registCapi` | String | 是 | 注册资本（金额数字+1个空格+万+货币单位） |  |
| `data.id` | String | 是 | 企业id |  |
| `data.tags` | Array | 是 | 企业标签：1-新三板；6-主板上市公司；40-暂停上市；41-终止上市；9-香港上市；17-高新企业； |  |
| `data.belongOrg` | String | 是 | 所属工商局 |  |
| `data.status` | String | 是 | 经营状态（工商公示原始字段用） |  |
| `data.termStart` | String | 是 | 营业开始日期 |  |
| `data.format_name` | String | 是 | 标准企业名称（清洗名称） |  |
| `data.historyNames` | Array | 是 | 历史名称 |  |
| `data.revoke_date` | String | 是 | 吊销日期 |  |
| `data.endDate` | String | 是 | 注销日期 |  |
| `data.regNo` | String | 是 | 企业注册号 |  |
| `data.econKindCode` | String | 是 | 企业类型代码 |  |
| `data.domain` | String | 是 | 四级行业 |  |
| `data.categoryNew` | String | 是 | 企业二级分类 0115601:企业;0115602:个体;0115603:农民专业合作社;0115699:其他类型0215601:社会团体;0215602:基金会;0215603:民办非企业单位;0215604:村民/居民委员会;0215605:宗教，工会等其他社会组织;0315601:事业单位;0315602:机关;0315603:其他机构编制;0434401:香港企业;0444602:澳门企业;0415803:台湾企业;0499904:国外企业;0515601:律所;0500099:其他组织机构; |  |
| `data.address` | String | 是 | 地址 |  |
| `data.orgNo` | String | 是 | 组织机构号 |  |
| `data.districtCode` | String | 是 | 地区代码 |  |
| `data.startDate` | String | 是 | 成立日期 |  |
| `data.scope` | String | 是 | 经营范围 |  |
| `data.name` | String | 是 | 企业名称（国家公示） |  |
| `data.creditNo` | String | 是 | 统一社会信用代码 |  |
| `data.new_status` | String | 是 | 经营状态（清洗后状态）。1：存续；2：注销；3：吊销；4：撤销，5：迁出，6：设立中，7：清算中，8：停业，9：其他 ,10：空，11：歇业，12：责令关闭；13：已取缔非法社会组织；14：涉嫌非法社会组织;15:待注销；16:生产中；17:解散 ；18:废止 ；19:核准设立；20：另册管理 |  |
| `data.operType` | String | 是 | 企业法定代表人类型 |  |
| `data.operPid` | String | 是 | 企业法定代表人标识 |  |
| `data.operName` | String | 是 | 企业法定代表人 |  |
| `data.title` | String | 是 | 公司代表人职务 |  |
| `data.checkDate` | String | 是 | 核准日期 |  |
| `data.actualCapi` | String | 是 | 实缴资本 |  |
| `data.termEnd` | String | 是 | 营业结束日期 |  |
| `data.currency_unit` | String | 是 | 货币单位 |  |
| `data.revoke_reason` | String | 是 | 吊销原因 |  |
| `data.type_new` | String | 是 | 企业大类 01-大陆企业 02-社会组织 03-机关及事业单位 04-港澳台及国外企业 05-律所及其他组织机构 |  |
| `data.logout_reason` | String | 是 | 注销原因 |  |
| `data.is_history` | Number | 是 | 是否历史 |  |
| `data.fenname` | String | 是 | 企业英文名 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 79.36 新增企业

- Hub：`POST /api/v1/data/enterprise/79.36/query`；上游方法 GET；可调用
- 说明：根据省份代码获得新增企业的详细信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `province_code` | String | 是 | 省份代码省份代码 province_code 代码：110000 北京 120000 天津 130000 河北省 140000 山西省 150000 内蒙古自治区 210000 辽宁省 220000 吉林省 230000 黑龙江省 310000 上海 320000 江苏省 330000 浙江省 340000 安徽省 350000 福建省 360000 江西省 370000 山东省 410000 河南省 420000 湖北省 430000 湖南省 440000 广东省 450000 广西壮族自治区 460000 海南省 500000 重庆 510000 四川省 520000 贵州省 530000 云南省 540000 西藏自治区 610000 陕西省 620000 甘肃省 630000 青海省 640000 宁夏回族自治区 650000 新疆维吾尔自治区 |
| `created_date` | String | 否 | 入库日期（格式YYYY-MM-DD） |
| `district_code` | String | 否 | 区域代码 |
| `start_date` | String | 否 | 成立日期（格式YYYY-MM-DD） |
| `industry_code` | String | 否 | 行业代码 |
| `category` | String | 否 | 企业类型，枚举：E：法人企业、社会组织、事 业单位等非个体户数据；P：个体户数据，默认 值为E，如需个体户数据，可以传入P获取 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条，最大30 000，即skip最大传值为29980） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 企业列表 |  |
| `data.items[].credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.items[].name` | String | 是 | 企业全称 |  |
| `data.items[].regist_capi` | Number | 是 | 注册资本（万元） |  |
| `data.items[].oper_name` | String | 是 | 法定代表人 |  |
| `data.items[].start_date` | String | 是 | 成立日期 |  |
| `data.items[].status` | String | 是 | 企业状态 |  |
| `data.items[].address` | String | 是 | 企业地址 |  |
| `data.items[].district` | String | 是 | 所在地区 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |

### 1.43 工商股东

- Hub：`POST /api/v1/data/enterprise/1.43/query`；上游方法 GET；可调用
- 说明：企业工商股东信息(不包含企业自行公示和年报股东)

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 企业股东及出资信息列表。 |  |
| `data.items[].totalRealCapi` | String | 是 | 总实缴 |  |
| `data.items[].name` | String | 是 | 股东姓名 |  |
| `data.items[].identifyNo` | String | 是 | 企业证照号 |  |
| `data.items[].totalShouldCapi` | String | 是 | 总认缴 |  |
| `data.items[].startDate` | String | 是 | 首次持股日期 |  |
| `data.items[].stockPercent` | String | 是 | 股比 |  |
| `data.items[].identifyType` | String | 是 | 类型 |  |
| `data.items[].shouldCapiItems` | Array | 是 | 认缴出资列表 |  |
| `data.items[].shouldCapiItems[].date` | String | 是 | 出资时间 |  |
| `data.items[].shouldCapiItems[].capi` | String | 是 | 认缴出资额 |  |
| `data.items[].shouldCapiItems[].type` | String | 是 | 出资方式 |  |
| `data.items[].realCapiItems` | Array | 是 | 实缴出资列表 |  |
| `data.items[].realCapiItems[].date` | String | 是 | 出资时间 |  |
| `data.items[].realCapiItems[].capi` | String | 是 | 实缴出资额 |  |
| `data.items[].realCapiItems[].type` | String | 是 | 出资方式 |  |
| `data.items[].stockType` | String | 是 | 股东类型 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 37.17 对外投资信息

- Hub：`POST /api/v1/data/enterprise/37.17/query`；上游方法 GET；可调用
- 说明：企业对外投资占比信息(使用最优股比计算)

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].name` | String | 是 | 被投资企业名称 |  |
| `data.items[].shortName` | String | 是 | 被投资企业简称 |  |
| `data.items[].investAmountCNY` | String | 是 | 投资金额（万人民币） |  |
| `data.items[].status` | String | 是 | 被投资企业经营状态 |  |
| `data.items[].shType` | String | 是 | 股东类型 |  |
| `data.items[].investCreditNo` | String | 是 | 被投资公司统一社会信用代码 |  |
| `data.items[].isHistory` | String | 是 | 是否历史（0：否，1：是） |  |
| `data.items[].shouldConDate` | String | 是 | 出资日期 |  |
| `data.items[].percent` | String | 是 | 占股比 |  |
| `data.items[].listingStatus` | String | 是 | 被投资公司上市状态（0: 非上市 1:上市（新三板、港股、A股上市）） |  |
| `data.items[].investRegCapi` | String | 是 | 被投资公司注册资本 |  |
| `data.items[].investStartDate` | String | 是 | 被投资公司成立日期 |  |
| `data.items[].investOperName` | String | 是 | 被投资公司法定代表人 |  |

### 57.18 最优股比信息

- Hub：`POST /api/v1/data/enterprise/57.18/query`；上游方法 GET；可调用
- 说明：启信宝根据大数据算法，综合多源数据算出的股比数据

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].name` | String | 是 | 股东名称 |  |
| `data.items[].type` | String | 是 | 类型（E-企业，P-其他） |  |
| `data.items[].shType` | String | 是 | 股东类型 |  |
| `data.items[].creditNo` | String | 是 | 统一社会信用代码 |  |
| `data.items[].investAmountCNY` | String | 是 | 投资金额（认缴金额，转换为人民币万元） |  |
| `data.items[].percent` | String | 是 | 占股比 |  |
| `data.items[].shouldCapiNum` | String | 是 | 认缴金额（万） |  |
| `data.items[].shouldCapiDate` | String | 是 | 认缴出资日期 |  |
| `data.items[].realCapi` | String | 是 | 实缴金额（万） |  |
| `data.items[].realCapidate` | String | 是 | 实缴出资日期 |  |
| `data.items[].currencyCode` | String | 是 | 币种代码 |  |
| `data.items[].stockNum` | String | 是 | 持股数量（适用于上市公司） |  |
| `data.items[].standardType` | String | 是 | 标准股东类型 |  |

### 1.50 工商股东（工商公示）

- Hub：`POST /api/v1/data/enterprise/1.50/query`；上游方法 GET；可调用
- 说明：企业工商股东信息(不包含企业自行公示和年报股东, 包含历史股东)

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.creditNo` | String | 是 | 被查询企业的统一社会信用代码 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 企业股东及出资信息列表。 |  |
| `data.items[].totalRealCapi` | String | 是 | 总实缴 |  |
| `data.items[].isHistory` | Number | 是 | 历史股东 |  |
| `data.items[].endDate` | String | 是 | 股东退出日期 |  |
| `data.items[].stockPercent` | String | 是 | 股东出资比例 |  |
| `data.items[].stockType` | String | 是 | 股东类型 |  |
| `data.items[].name` | String | 是 | 股东姓名 |  |
| `data.items[].pid` | String | 是 | 人员id（股东为自然人显示pid） |  |
| `data.items[].shouldCapiItems` | Array | 是 | 认缴出资列表 |  |
| `data.items[].shouldCapiItems[].date` | String | 是 | 出资时间 |  |
| `data.items[].shouldCapiItems[].capi` | String | 是 | 认缴出资额 |  |
| `data.items[].shouldCapiItems[].type` | String | 是 | 出资方式 |  |
| `data.items[].totalShouldCapi` | String | 是 | 总认缴 |  |
| `data.items[].eid` | String | 是 | 企业id（股东为企业显示eid） |  |
| `data.items[].identifyType` | String | 是 | 证件类型 |  |
| `data.items[].identifyNo` | String | 是 | 企业证照号 |  |
| `data.items[].realCapiItems` | Array | 是 | 实缴出资列表 |  |
| `data.items[].realCapiItems[].date` | String | 是 | 出资时间 |  |
| `data.items[].realCapiItems[].capi` | String | 是 | 实缴出资额 |  |
| `data.items[].realCapiItems[].type` | String | 是 | 出资方式 |  |
| `data.items[].startDate` | String | 是 | 开始参股日期 |  |
| `data.items[].startActual` | Number | 是 | 开始参股日期是否是实际变更日期（默认：2未知；0:否1：是） |  |
| `data.items[].endActual` | Number | 是 | 股东退出日期是否为实际变更日期(默认: 2:未知 0:否 1:是) |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 34.3 股权变更（工商公示）

- Hub：`POST /api/v1/data/enterprise/34.3/query`；上游方法 GET；可调用
- 说明：企业股权变更信息，包括股权变更前及变更后信息等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回数量 |  |
| `data.list` | Array | 是 | 详情 |  |
| `data.list[].id` | String | 是 | 企业ID |  |
| `data.list[].name` | String | 是 | 企业名称 |  |
| `data.list[].before_percent` | String | 是 | 股权更改前 |  |
| `data.list[].after_percent` | String | 是 | 股权更改后 |  |
| `data.list[].change_date` | String | 是 | 记录变更时间 |  |
| `data.list[].public_date` | String | 是 | 记录发布时间 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 1.45 主要人员

- Hub：`POST /api/v1/data/enterprise/1.45/query`；上游方法 GET；可调用
- 说明：企业工商主要人员信息，包括主要人员姓名及职位

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 主要人员信息列表 |  |
| `data.items[].pid` | String | 是 | 主要人员标识 |  |
| `data.items[].name` | String | 是 | 主要人员姓名 |  |
| `data.items[].is_history` | number | 是 | 是否历史，是否历史；0：否1：是 |  |
| `data.items[].title` | String | 是 | 主要人员职位 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 1.8 企业基础工商信息

- Hub：`POST /api/v1/data/enterprise/1.8/query`；上游方法 GET；可调用
- 说明：企业工商信息（含工商公示企业联系方式、照面信息、主要人员、工商变更、股东信息、经营异常等）

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.status` | String | 是 | 经营状态（工商公示原始数据） |  |
| `data.actual_capi` | String | 是 | 实收资本 |  |
| `data.org_no` | String | 是 | 组织机构号 |  |
| `data.branches` | Array | 是 | 分支机构信息 |  |
| `data.branches[].name` | String | 是 | 分支机构名称 |  |
| `data.branches[].id` | String | 是 | 分支机构id |  |
| `data.term_end` | String | 是 | 营业结束日期 |  |
| `data.scope` | String | 是 | 经营范围 |  |
| `data.partners` | Array | 是 | 股东信息 |  |
| `data.partners[].name` | String | 是 | 股东姓名 |  |
| `data.partners[].stock_type` | String | 是 | 股东类型 |  |
| `data.partners[].identify_type` | String | 是 | 证件类型 |  |
| `data.partners[].stock_percent` | String | 是 | 股东出资比例 |  |
| `data.partners[].identify_no` | String | 是 | 企业证照号 |  |
| `data.partners[].real_capi_items` | Array | 是 | 实缴出资信息 |  |
| `data.partners[].real_capi_items[].real_capi` | String | 是 | 实缴出资额 |  |
| `data.partners[].real_capi_items[].invest_type` | String | 是 | 出资方式 |  |
| `data.partners[].real_capi_items[].real_capi_date` | String | 是 | 实缴时间 |  |
| `data.partners[].total_real_capi` | String | 是 | 股东总实缴 |  |
| `data.partners[].total_should_capi` | String | 是 | 股东总认缴 |  |
| `data.partners[].should_capi_items` | Array | 是 | 认缴出资信息 |  |
| `data.partners[].should_capi_items[].shoud_capi` | String | 是 | 认缴出资额 |  |
| `data.partners[].should_capi_items[].invest_type` | String | 是 | 出资方式 |  |
| `data.partners[].should_capi_items[].should_capi_date` | String | 是 | 出资时间 |  |
| `data.credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.start_date` | String | 是 | 成立日期 |  |
| `data.domains` | Array | 是 | 行业 |  |
| `data.district_code` | String | 是 | 地区代码 |  |
| `data.quoted_type` | Array | 是 | 上市类型，数组，1:新三板，6:沪深市，9:香港上市 |  |
| `data.city` | String | 是 | 城市编码 |  |
| `data.regist_capi` | String | 是 | 注册资本 |  |
| `data.reg_no` | String | 是 | 企业注册号 |  |
| `data.belong_org` | String | 是 | 所属工商局 |  |
| `data.address` | String | 是 | 地址 |  |
| `data.name` | String | 是 | 企业名称 |  |
| `data.format_name` | String | 是 | 标准名称 |  |
| `data.employees` | Array | 是 | 主要人员信息 |  |
| `data.employees[].job_title` | String | 是 | 主要人员职位 |  |
| `data.employees[].name` | String | 是 | 主要人员姓名 |  |
| `data.oper_name` | String | 是 | 企业法定代表人 |  |
| `data.econ_kind_code` | String | 是 | 企业类型代码 |  |
| `data.id` | String | 是 | 企业id |  |
| `data.changerecords` | Array | 是 | 变更记录 |  |
| `data.changerecords[].change_item` | String | 是 | 变更项目 |  |
| `data.changerecords[].change_date` | String | 是 | 变更日期 |  |
| `data.changerecords[].before_content` | String | 是 | 变更前内容 |  |
| `data.changerecords[].after_content` | String | 是 | 变更后内容 |  |
| `data.changerecords[].tag` | String | 是 | 历史信息标签 |  |
| `data.abnormal_items` | Array | 是 | 经营异常信息 |  |
| `data.abnormal_items[].in_reason` | String | 是 | 经营异常列入原因 |  |
| `data.abnormal_items[].in_date` | String | 是 | 列入日期 |  |
| `data.abnormal_items[].out_reason` | String | 是 | 移出原因 |  |
| `data.abnormal_items[].out_date` | String | 是 | 移出时间 |  |
| `data.abnormal_items[].department` | String | 是 | 处罚部门 |  |
| `data.abnormal_items[].is_history` | String | 是 | 是否历史：0否1是 |  |
| `data.end_date` | String | 是 | 注销日期 |  |
| `data.province` | String | 是 | 省份缩写（参见附录province-code） |  |
| `data.websites` | Array | 是 | 企业网址信息 |  |
| `data.websites[].web_name` | String | 是 | 企业网址名称 |  |
| `data.websites[].web_type` | String | 是 | 网址类型 |  |
| `data.websites[].web_url` | String | 是 | 网址 | 🔗 |
| `data.websites[].source` | String | 是 | 网址来源（无意义） |  |
| `data.websites[].seq_no` | Number | 是 | 编号 |  |
| `data.websites[].date` | String | 是 | 审核时间 |  |
| `data.organization_code` | String | 是 | 组织分类代码； 机关：1560101 ；事业单位：1560102 ；中央编办直接管理机构编制的群众团体 ：1560103 ；律师执业机构：1560201 ；公证处：1560202 ；基层法律服务所：1560203 ；司法鉴定机构：1560204 ；仲裁委员会：1560205 ；社会团体：1560301 ；民办非企业单位：1560302 ；基金会：1560303 ；村民委员会：1560304 ；居民委员会：1560305 ；基层工会：1560401 ；企业：1560501 ；个体工商户：1560502 ；农民专业合作社：1560503 ；组级集体经济组织：1560601 ；村级集体经济组织：1560602 ；乡镇级集体经济组织：1560603 ；其他：1569999 ；香港：3440101 ；澳门：4660101 ；台湾：1580101 |  |
| `data.econ_kind` | String | 是 | 企业类型 |  |
| `data.new_status` | String | 是 | 经营状态（清洗后状态）。1：存续；2：注销；3：吊销；4：撤销，5：迁出，6：设立中，7：清算中，8：停业，9：其他 ,10：空，11：歇业，12：责令关闭；13：已取缔非法社会组织；14：涉嫌非法社会组织;15:待注销；16:生产中；17:解散 ；18:废止 ；19:核准设立；20：另册管理 |  |
| `data.is_quoted` | String | 是 | 是否上市(0:未上市，1:上市) |  |
| `data.contact` | Object | 是 | 联系方式 |  |
| `data.contact.address` | String | 是 | 地址 |  |
| `data.contact.telephone` | String | 是 | 电话 |  |
| `data.contact.email` | String | 是 | 邮件 |  |
| `data.term_start` | String | 是 | 营业开始日期 |  |
| `data.history_names` | Array | 是 | 历史名称 |  |
| `data.industry_code` | Object | 是 | 行业代码 |  |
| `data.industry_code.indu_code_l1` | String | 是 | 一级行业代码 |  |
| `data.industry_code.indu_l1` | String | 是 | 一级行业描述 |  |
| `data.industry_code.indu_code_l2` | String | 是 | 二级行业代码 |  |
| `data.industry_code.indu_l2` | String | 是 | 二级行业描述 |  |
| `data.industry_code.indu_code_l3` | String | 是 | 三级行业代码 |  |
| `data.industry_code.indu_l3` | String | 是 | 三级行业描述 |  |
| `data.industry_code.indu_code_l4` | String | 是 | 四级行业代码 |  |
| `data.industry_code.indu_l4` | String | 是 | 四级行业描述 |  |
| `data.collegues_num` | String | 是 | 从业人数 |  |
| `data.is_history` | String | 是 | 是否历史（0-否；1-是） |  |
| `data.check_date` | String | 是 | 核准日期 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 1.47 变更记录

- Hub：`POST /api/v1/data/enterprise/1.47/query`；上游方法 GET；可调用
- 说明：企业工商变更记录信息，包括变更项目、变更日期，以及前后变更内容等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |
| `type_code` | Number | 否 | 变更类型（默认全部），1 企业名称变更 2 企业类型变更 3 证照号变更 4 注册资金变更 5 地址变更 6 联系方式变更 7 经营范围变更 8 负责人变更 9 股东股权变更 10 人员变更 11 分支机构变更 12 隶属关系变更 13 期限变更 14其他 15 章程备案变更 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].changeItem` | String | 是 | 变更项目 |  |
| `data.items[].type` | String | 是 | 变更类型，如负责人变更，地址变更，经营范围变更，企业名称变更，股东股权变更，企业类型变更，人员变更，注册资金变更，联系方式变更，期限变更，分支机构变更，登记管辖变更，行业变更，证照号变更，实收资本变更，隶属关系变更，章程备案变更，其他变更 |  |
| `data.items[].changeDate` | String | 是 | 变更日期（排序字段，降序排列） |  |
| `data.items[].beforeContent` | String | 是 | 变更前内容 |  |
| `data.items[].afterContent` | String | 是 | 变更后内容 |  |
| `data.items[].tag` | String | 是 | 历史信息标签（历史信息/非历史信息） |  |

### 1.51 企业联系方式

- Hub：`POST /api/v1/data/enterprise/1.51/query`；上游方法 GET；可调用
- 说明：工商公示企业联系方式，包括地址、电话、邮件

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.address` | String | 是 | 地址 |  |
| `data.telephone` | String | 是 | 电话 |  |
| `data.regNo` | String | 是 | 企业注册号 |  |
| `data.name` | String | 是 | 企业名称 |  |
| `data.email` | String | 是 | 邮件 |  |
| `data.creditNo` | String | 是 | 统一社会信用代 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 1.49 分支机构

- Hub：`POST /api/v1/data/enterprise/1.49/query`；上游方法 GET；可调用
- 说明：企业分支机构信息，包括分支机构名称、企业法定代表人、成立日期、注册资本等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 分支机构信息列表。 |  |
| `data.items[].name` | String | 是 | 分支机构名称 |  |
| `data.items[].registCapi` | String | 是 | 注册资本 |  |
| `data.items[].eid` | String | 是 | 企业ID |  |
| `data.items[].startDate` | String | 是 | 成立日期 |  |
| `data.items[].belongOrg` | String | 是 | 登记机关 |  |
| `data.items[].operName` | String | 是 | 企业法定代表人 |  |
| `data.items[].status` | String | 是 | 企业状态 |  |
| `data.items[].creditNo` | String | 是 | 统一社会信用代码 |  |
| `data.items[].newStatusCode` | String | 是 | 企业状态码，枚举值为：1：存续；2：注销；3：吊销；4：撤销，5：迁出，6：设立中，7：清算中，8：停业，9：其他 ,10：空，11：歇业，12：责令关闭；13：已取缔非法社会组织；14：涉嫌非法社会组织;15:待注销 |  |
| `data.items[].regNo` | String | 是 | 注册号 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 79.18 分支机构所属总公司核查

- Hub：`POST /api/v1/data/enterprise/79.18/query`；上游方法 GET；可调用
- 说明：通过分支机构名称获取所归属的总公司

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.h_name` | String | 是 | 总公司全称 |  |
| `data.credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.regist_capi` | String | 是 | 注册资本（万元） |  |
| `data.oper_name` | String | 是 | 法定代表人 |  |
| `data.start_date` | String | 是 | 成立日期 |  |
| `data.scope` | String | 是 | 经营范围 |  |
| `data.status` | String | 是 | 企业状态 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 1.53 企业年报网址

- Hub：`POST /api/v1/data/enterprise/1.53/query`；上游方法 GET；可调用
- 说明：企业年报网址信息，包括网站名称、网址、网址类型、网址来源、审核时间等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 企业股东及出资信息列表 |  |
| `data.items[].date` | String | 是 | 审核时间 |  |
| `data.items[].source` | String | 是 | 来源 |  |
| `data.items[].url` | String | 是 | 网址 | 🔗 |
| `data.items[].name` | String | 是 | 企业网址名称 |  |
| `data.items[].type` | String | 是 | 网址类型 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 3.1 工商年报

- Hub：`POST /api/v1/data/enterprise/3.1/query`；上游方法 GET；可调用
- 说明：企业工商年报信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 企业年报信息列表 |  |
| `data.items[].report_name` | String | 是 | 年报名称 |  |
| `data.items[].female_collegues_num` | String | 是 | 女性从业人数 |  |
| `data.items[].enterprise_holding_situation` | String | 是 | 企业控股情况 |  |
| `data.items[].sup_ename` | String | 是 | 隶属企业名称 |  |
| `data.items[].sup_credit_no` | String | 是 | 隶属企业统一社会信用代码或注册号 |  |
| `data.items[].sup_eid` | String | 是 | 隶属企业ID |  |
| `data.items[].if_website` | String | 是 | 是否有网站或网店 |  |
| `data.items[].sale_income` | String | 是 | 营业总收入 |  |
| `data.items[].reg_no` | String | 是 | 注册号 |  |
| `data.items[].email` | String | 是 | 电子邮箱 |  |
| `data.items[].address` | String | 是 | 企业通信地址 |  |
| `data.items[].guarantee_items` | Array | 是 | 债务信息 |  |
| `data.items[].guarantee_items[].creditor` | String | 是 | 债权人 |  |
| `data.items[].guarantee_items[].debitor` | String | 是 | 债务人 |  |
| `data.items[].guarantee_items[].debit_type` | String | 是 | 主债权种类 |  |
| `data.items[].guarantee_items[].debit_amount` | String | 是 | 主债权数额 |  |
| `data.items[].guarantee_items[].debit_period` | String | 是 | 履行债务的期限 |  |
| `data.items[].guarantee_items[].guarant_method` | String | 是 | 保证的方式 |  |
| `data.items[].guarantee_items[].guarant_period` | String | 是 | 保证的期间 |  |
| `data.items[].guarantee_items[].guarant_scope` | String | 是 | 保证担保的范围 |  |
| `data.items[].fare_scope` | String | 是 | 主营业务 |  |
| `data.items[].total_equity` | String | 是 | 资产总额 |  |
| `data.items[].tax_total` | String | 是 | 纳税总额 |  |
| `data.items[].name` | String | 是 | 企业名称 |  |
| `data.items[].if_external_guarantee` | String | 是 | 是否提供对外担保 |  |
| `data.items[].partners` | Array | 是 | 股东信息 |  |
| `data.items[].partners[].identify_type` | String | 是 | 证件类型 |  |
| `data.items[].partners[].should_capi_items` | Array | 是 | 应缴出资信息 |  |
| `data.items[].partners[].should_capi_items[].should_capi_date` | String | 是 | 认缴出资时间 |  |
| `data.items[].partners[].should_capi_items[].shoud_capi` | String | 是 | 认缴出资额 |  |
| `data.items[].partners[].should_capi_items[].invest_type` | String | 是 | 认缴出资方式 |  |
| `data.items[].partners[].stock_type` | String | 是 | 股东类型 |  |
| `data.items[].partners[].real_capi_items` | Array | 是 | 实缴出资信息 |  |
| `data.items[].partners[].real_capi_items[].real_capi` | String | 是 | 实缴出资额 |  |
| `data.items[].partners[].real_capi_items[].invest_type` | String | 是 | 实缴出资方式 |  |
| `data.items[].partners[].real_capi_items[].real_capi_date` | String | 是 | 实缴出资时间 |  |
| `data.items[].partners[].stock_name` | String | 是 | 股东名称 |  |
| `data.items[].partners[].identify_no` | String | 是 | 企业证照号 |  |
| `data.items[].partners[].stock_percent` | String | 是 | 股东所占比例（目前工商无数据，不返回） |  |
| `data.items[].oper_name` | String | 是 | 企业法定代表人 |  |
| `data.items[].telephone` | String | 是 | 企业联系电话 |  |
| `data.items[].status` | String | 是 | 企业标准经营状态（已废弃） |  |
| `data.items[].profit_reta` | String | 是 | 所有者权益合计 |  |
| `data.items[].zip_code` | String | 是 | 邮政编码 |  |
| `data.items[].prac_person_num` | String | 是 | 实际员工数量 |  |
| `data.items[].profit_total` | String | 是 | 利润总额 |  |
| `data.items[].reg_capi` | String | 是 | 注册资本 |  |
| `data.items[].if_invest` | String | 是 | 企业是否有投资信息或购买其他公司股权 |  |
| `data.items[].report_date` | String | 是 | 发布日期 |  |
| `data.items[].websites` | Array | 是 | 网站信息 |  |
| `data.items[].websites[].web_type` | String | 是 | 网站类型 |  |
| `data.items[].websites[].web_name` | String | 是 | 网站名称 |  |
| `data.items[].websites[].web_url` | String | 是 | 网站网址 | 🔗 |
| `data.items[].serv_fare_income` | String | 是 | 主营业务收入 |  |
| `data.items[].stock_changes` | Array | 是 | 股权变更信息 |  |
| `data.items[].stock_changes[].name` | String | 是 | 股东 |  |
| `data.items[].stock_changes[].before_percent` | String | 是 | 变更前股权比例 |  |
| `data.items[].stock_changes[].after_percent` | String | 是 | 变更后股权比例 |  |
| `data.items[].stock_changes[].public_date` | String | 是 | 发布日期 |  |
| `data.items[].stock_changes[].change_date` | String | 是 | 股权变更日期 |  |
| `data.items[].if_equity` | String | 是 | 有限责任公司本年度是否发生股东股权转 |  |
| `data.items[].report_year` | String | 是 | 年报年份 |  |
| `data.items[].credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.items[].collegues_num` | String | 是 | 从业人数 |  |
| `data.items[].origin_status` | String | 是 | 企业经营状态 |  |
| `data.items[].net_amount` | String | 是 | 净利润 |  |
| `data.items[].invest_items` | Array | 是 | 对外投资信息 |  |
| `data.items[].invest_items[].invest_name` | String | 是 | 对外投资企业名称 |  |
| `data.items[].invest_items[].invest_reg_no` | String | 是 | 对外投资企业注册号 |  |
| `data.items[].invest_items[].invest_capi` | String | 是 | 对外投资金额 |  |
| `data.items[].invest_items[].invest_percent` | String | 是 | 对外投资比例 |  |
| `data.items[].debit_amount` | String | 是 | 负债总额 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 1.16 企业简介

- Hub：`POST /api/v1/data/enterprise/1.16/query`；上游方法 GET；可调用
- 说明：企业简介信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/统一社会信用代码/注册号 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.name` | String | 是 | 企业名称 |  |
| `data.brief` | String | 是 | 企业简介 |  |
| `data.id` | String | 是 | 企业ID |  |

### 1.17 企业LOGO

- Hub：`POST /api/v1/data/enterprise/1.17/query`；上游方法 GET；可调用
- 说明：企业LOGO

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.logo` | String | 是 | 企业logourl地址 | 🔗 |
| `data.name` | String | 是 | 企业名称 |  |
| `data.id` | String | 是 | 企业ID |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 3.3 社保信息

- Hub：`POST /api/v1/data/enterprise/3.3/query`；上游方法 GET；可调用
- 说明：企业工商年报披露的社保信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 社保信息列表 |  |
| `data.items[].social_security` | Array | 是 | 单位参加社保信息 |  |
| `data.items[].social_security[].unenployment_insurance` | String | 是 | 单位参加失业保险缴费基数 |  |
| `data.items[].social_security[].endownment_insurance_amount` | String | 是 | 单位参加城镇职工基本养老保险累计欠 缴金额 |  |
| `data.items[].social_security[].actual_lost_amount` | String | 是 | 参加失业保险本期实际缴费金额 |  |
| `data.items[].social_security[].base_medical_down_balance` | String | 是 | 单位参加职工基本医疗保险累计欠缴金额 |  |
| `data.items[].social_security[].unenployment_num` | String | 是 | 失业保险人数 |  |
| `data.items[].social_security[].endownment_base_amount` | String | 是 | 单位参加城镇职工基本养老保险缴费基 数 |  |
| `data.items[].social_security[].injury_insurance_amount` | String | 是 | 单位参加工伤保险缴费基数 |  |
| `data.items[].social_security[].insurance_num` | String | 是 | 职工基本医疗保险人数 |  |
| `data.items[].social_security[].birth_amount` | String | 是 | 单位参加生育保险累计欠缴金额 |  |
| `data.items[].social_security[].birth_insurance_count` | String | 是 | 单位参加生育保险缴费基数 |  |
| `data.items[].social_security[].actual_medical_amount` | String | 是 | 参加职工基本医疗保险本期实际缴费金额 |  |
| `data.items[].social_security[].actual_injury_amount` | String | 是 | 参加工伤保险本期实际缴费金额 |  |
| `data.items[].social_security[].company_injury_down_balance` | String | 是 | 单位参加工伤保险累计欠缴金额 |  |
| `data.items[].social_security[].birth_num` | String | 是 | 生育保险人数 |  |
| `data.items[].social_security[].birth_actual_amount` | String | 是 | 参加生育保险本期实际缴费金额 |  |
| `data.items[].social_security[].basic_endownment_num` | String | 是 | 城镇职工基本养老保险人数 |  |
| `data.items[].social_security[].injury_insurance_num` | String | 是 | 工伤保险人数 |  |
| `data.items[].social_security[].unenployment_down_balance` | String | 是 | 单位参加失业保险累计欠缴金额 |  |
| `data.items[].social_security[].actual_endownment_amount` | String | 是 | 参加城镇职工基本养老保险本期实际缴费金额 |  |
| `data.items[].social_security[].basic_medical_amount` | String | 是 | 单位参加职工基本医疗保险缴费基数 |  |
| `data.items[].name` | String | 是 | 企业名称 |  |
| `data.items[].report_year` | String | 是 | 年报年份 |  |
| `data.items[].report_date` | String | 是 | 发布日期 |  |
| `data.items[].dw_je_display` | String | 是 | 是否展示欠缴金额 |  |
| `data.items[].bq_je_display` | String | 是 | 是否展示实际缴费金额 |  |
| `data.items[].dw_js_display` | String | 是 | 是否展示单位缴费基数 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 1.32 企业名/法定代表人名称二要素验证

- Hub：`POST /api/v1/data/enterprise/1.32/query`；上游方法 GET；可调用
- 说明：企业名,法定代表人姓名一致性验证

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名 |
| `oper` | String | 是 | 法定代表人姓名 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.remark` | String | 是 | 备注 |  |
| `data.result` | String | 是 | 匹配结果值，如下0：不一致1：一致2：输入企业名疑似曾用名。法定代表人姓名一致 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 91.59 企业名/统一社会信用代码二要素验证

- Hub：`POST /api/v1/data/enterprise/91.59/query`；上游方法 GET；可调用
- 说明：企业名，统一社会信用代码一致性验证

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业名称 |
| `creditNo` | String | 是 | 统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.result` | String | 是 | 匹配结果值，如下 0 ：不一致 1 ：一致 |  |

### 1.27 三要素验证

- Hub：`POST /api/v1/data/enterprise/1.27/query`；上游方法 GET；可调用
- 说明：企业名,统一社会信用代码,法定代表人姓名一致性验证

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名，如企业名称实际为空，则填“*”代替 |
| `code` | String | 是 | 统一社会信用代码 |
| `oper` | String | 是 | 法定代表人姓名，如法人实际为空，则填写“-”代替 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.remark` | String | 是 | 备注 |  |
| `data.result` | String | 是 | 匹配结果值，如下 0 ：不一致 1 ：一致 2 ：输入企业名疑似曾用名，其他两要素一致 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 1.30 四要素验证

- Hub：`POST /api/v1/data/enterprise/1.30/query`；上游方法 GET；可调用
- 说明：企业名,统一社会信用代码,法定代表人姓名,营业期限一致性验证

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名 |
| `code` | String | 是 | 统一社会信用代码 |
| `oper` | String | 是 | 法定代表人姓名 |
| `start` | String | 是 | 营业期限始，请严格按照以下格式传入，如：20100303 否则可能导致比对有误差 |
| `end` | String | 否 | 营业期限至，请严格按照以下格式传入，如： 20300302 否则可能导致比对有误差 如果执照上的截至日期是"长期"，则无需传入本参数 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 否 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.remark` | String | 否 | 备注 |  |
| `data.result` | String | 否 | 匹配结果值，如下 0 ：不一致 1 ：一致 2 ：输入企业名疑似曾用名。统一社会信用代码，法定代表人姓名和营业期限一致 |  |
| `sign` | String | 否 | 数据签名 |  |
| `status` | String | 否 | 返回结果状态 |  |
| `message` | String | 否 | 返回结果消息 |  |

### 35.2 律所基本信息

- Hub：`POST /api/v1/data/enterprise/35.2/query`；上游方法 GET；可调用
- 说明：律所基本信息查询，包括律所负责人、成立日期、注册资本等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.zip` | String | 是 | 邮编 |  |
| `data.website` | String | 是 | 主页网址 | 🔗 |
| `data.brief` | String | 是 | 事务所简介 |  |
| `data.status` | String | 是 | 机构状态 |  |
| `data.email` | String | 是 | 邮箱 |  |
| `data.address` | String | 是 | 地址 |  |
| `data.organization_form` | String | 是 | 组织形式 |  |
| `data.reg_capi` | String | 是 | 注册资金,资产 |  |
| `data.app_no` | String | 是 | 执业证批准文号 |  |
| `data.id` | String | 是 | 企业Id |  |
| `data.charge_ju` | String | 是 | 主管机关 |  |
| `data.turnover` | String | 是 | 年营业额 |  |
| `data.org_code` | String | 是 | 组织机构代码 |  |
| `data.fax` | String | 是 | 传真 |  |
| `data.law_name_en` | String | 是 | 英文名 |  |
| `data.scale` | String | 是 | 规模 |  |
| `data.industry` | String | 是 | 行业 |  |
| `data.short_name` | String | 是 | 简称 |  |
| `data.credit_no` | String | 是 | 社会信用代码 |  |
| `data.leader` | String | 是 | 负责人 |  |
| `data.main_core` | String | 是 | 主营业务 |  |
| `data.law_type` | String | 是 | 总所分所 |  |
| `data.law_name_cn` | String | 是 | 中文名 |  |
| `data.phone` | String | 是 | 办公电话 |  |
| `data.issuance_date` | String | 是 | 成立日期 |  |
| `data.reg_no` | String | 是 | 执业证号 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 47.96 事业单位基本信息

- Hub：`POST /api/v1/data/enterprise/47.96/query`；上游方法 GET（可选 GET/POST）；可调用
- 说明：通过事业单位名称/社会统一信用代码获取事业单位详情

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.ename` | String | 是 | 事业单位名称 |  |
| `data.credit_no` | String | 是 | 社会代码 |  |
| `data.reg_no` | String | 是 | 注册号 |  |
| `data.start_date` | String | 是 | 成立日期 |  |
| `data.oper_name` | String | 是 | 法定代表人 |  |
| `data.status` | String | 是 | 登记状态 |  |
| `data.new_status_code` | String | 是 | 登记状态码 |  |
| `data.regist_capi` | String | 是 | 注册资本 |  |
| `data.regist_capi_new` | String | 是 | 注册资本数字 |  |
| `data.currency_unit` | String | 是 | 注册资本的货币种类 |  |
| `data.agency` | String | 是 | 登记管理机关 |  |
| `data.expenditure_source` | String | 是 | 经费来源 |  |
| `data.org_type` | String | 是 | 组织类型 |  |
| `data.certificate_start_date` | String | 是 | 证书生效日期 |  |
| `data.certificate_end_date` | String | 是 | 证书失效日期 |  |
| `data.fax` | String | 是 | 传真号 |  |
| `data.approve_department` | String | 是 | 举办单位/批准机构名称 |  |
| `data.wechat_public_account` | String | 是 | 官方微信公众号 |  |
| `data.weibo` | String | 是 | 官方微博 |  |
| `data.mobile_client` | String | 是 | 移动客户端等其他网络平台 |  |
| `data.tax_deduction` | String | 是 | 是否取得公益性捐赠税前扣除资格（0：否 1：是 -1：未知 ） |  |
| `data.tax_deduction_start_date` | String | 是 | 税前扣除资格有效期开始日期 |  |
| `data.tax_deduction_end_date` | String | 是 | 税前扣除资格有效期结束日期 |  |
| `data.can_public` | String | 是 | 是否具有公开募捐资格（ 0：否 1：是 -1：未知 ） |  |
| `data.purpose` | String | 是 | 宗旨和业务范围 |  |
| `data.address` | String | 是 | 地址 |  |

### 36.2 社会组织基本信息

- Hub：`POST /api/v1/data/enterprise/36.2/query`；上游方法 GET；可调用
- 说明：社会组织基本信息查询，包括登记证号、注册资本、法定代表人/负责人等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.org_type` | String | 是 | 社会组织类型 |  |
| `data.id` | String | 是 | 企业Id |  |
| `data.domain` | String | 是 | 网址 | 🔗 |
| `data.department` | String | 是 | 所属工商局 |  |
| `data.start_date` | String | 是 | 成立日期 |  |
| `data.address` | String | 是 | 联系地址 |  |
| `data.people` | String | 是 | 法定代表人/负责人 |  |
| `data.org_no` | String | 是 | 组织机构代码 |  |
| `data.end_date` | String | 是 | 注销时间 |  |
| `data.reg_capi` | String | 是 | 注册资本 |  |
| `data.agency` | String | 是 | 登记管理机关 |  |
| `data.scope` | String | 是 | 业务范围 |  |
| `data.name` | String | 是 | 社团名称 |  |
| `data.act_region` | String | 是 | 活动区域 |  |
| `data.validity_date` | String | 是 | 证书有效期 |  |
| `data.zip` | String | 是 | 邮编 |  |
| `data.ind_type` | String | 是 | 行业分类 |  |
| `data.telephone` | String | 是 | 联系电话 |  |
| `data.reg_no` | String | 是 | 登记证号 |  |
| `data.case_no` | String | 是 | 社会信用代码 |  |
| `data.status` | String | 是 | 组织状态 |  |
| `data.type` | String | 是 | 省份缩写 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 88.49 基金会基本信息

- Hub：`POST /api/v1/data/enterprise/88.49/query`；上游方法 GET；可调用
- 说明：基金会详细信息查询，包括登记状态，原始基金，登记管理机关，证书生效日期等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.eid` | String | 是 | 基金会id |  |
| `data.credit_no` | String | 是 | 社会代码 |  |
| `data.reg_no` | String | 是 | 注册号 |  |
| `data.name` | String | 是 | 基金会名称 |  |
| `data.start_date` | String | 是 | 成立日期 |  |
| `data.oper_name` | String | 是 | 法定代表人/理事长 |  |
| `data.status` | String | 是 | 登记状态 |  |
| `data.new_status_code` | String | 是 | 登记状态码 |  |
| `data.regist_capi` | String | 是 | 原始基金/注册资本 |  |
| `data.regist_capi_new` | String | 是 | 原始基金数额 |  |
| `data.currency_unit` | String | 是 | 原始基金币种 |  |
| `data.agency` | String | 是 | 登记管理机关 |  |
| `data.org_type` | String | 是 | 组织类型 |  |
| `data.scope` | String | 是 | 业务范围 |  |
| `data.certificate_start_date` | String | 是 | 证书生效日期 |  |
| `data.certificate_end_date` | String | 是 | 证书失效日期 |  |
| `data.fax` | String | 是 | 传真号 |  |
| `data.department` | String | 是 | 业务主管单位 |  |
| `data.wechat_public_account` | String | 是 | 官方微信公众号 |  |
| `data.mobile_client` | String | 是 | 移动客户端等其他网络平台 |  |
| `data.weibo` | String | 是 | 官方微博 |  |
| `data.tax_deduction` | String | 是 | 是否取得公益性捐赠税前扣除资格（0：否 1：是 -1：未知 ） |  |
| `data.tax_deduction_start_date` | String | 是 | 税前扣除资格有效期开始日期 |  |
| `data.tax_deduction_end_date` | String | 是 | 税前扣除资格有效期结束日期 |  |
| `data.can_public` | String | 是 | 是否具有公开募捐资格（0：否 1：是 -1：未知 ） |  |
| `data.charity_approve_date` | String | 是 | 慈善组织认定登记日期 |  |
| `data.rule` | String | 是 | 章程 | 🔗 |
| `data.purpose` | String | 是 | 宗旨 |  |
| `data.contact` | String | 是 | 联系人 |  |
| `data.secretary_general` | String | 是 | 秘书长 |  |
| `data.fund_type` | String | 是 | 募集类型 |  |
| `data.url` | String | 是 | 数据链接 | 🔗 |

### 46.1 香港企业信息

- Hub：`POST /api/v1/data/enterprise/46.1/query`；上游方法 GET；可调用
- 说明：香港企业基本信息查询，包括公司编号、中英文名称、公司成立日期等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 公司全名（中文或英文） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.id` | String | 是 | 企业ID |  |
| `data.name_en` | String | 是 | 公司名称-英文 |  |
| `data.important_matter` | String | 是 | 重要事项 |  |
| `data.status` | String | 是 | 公司现况 |  |
| `data.dissolution_date` | String | 是 | 已告解散日期 |  |
| `data.name_cn` | String | 是 | 公司名称-中文（繁体或者简体） |  |
| `data.model` | String | 是 | 清盘模式 |  |
| `data.register_charges` | String | 是 | 押记登记册 |  |
| `data.condition` | String | 是 | 公司现况 |  |
| `data.name_jt` | String | 是 | 公司名称-简体中文 |  |
| `data.case_no` | String | 是 | 公司编号 |  |
| `data.br_number` | String | 是 | 商业登记证号码 |  |
| `data.date` | String | 是 | 成立日期 |  |
| `data.name_list` | Array | 是 | 公司名称纪录 |  |
| `data.name_list[].names` | Array | 是 | 公司名称纪录.名称 |  |
| `data.name_list[].date` | String | 是 | 公司名称纪录.生效日期 |  |
| `data.type` | String | 是 | 公司类别 |  |
| `data.format_name` | String | 是 | 标准名称 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 59.5 主要人员对外投资任职信息

- Hub：`POST /api/v1/data/enterprise/59.5/query`；上游方法 GET；可调用
- 说明：企业法定代表人或董监高对外投资占比信息(使用最优股比计算)

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `company` | String | 是 | 企业全名、统代、注册号 |
| `name` | String | 是 | 自然人名 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.oper_info` | Array | 是 | 法人代表信息列表 |  |
| `data.oper_info[].name` | String | 是 | 法定代表人 |  |
| `data.oper_info[].pid` | String | 是 | 人员id |  |
| `data.oper_info[].company` | String | 是 | 企业名称 |  |
| `data.oper_info[].credit_no` | String | 是 | 企业统一社会信用代码/注册号 |  |
| `data.oper_info[].eid` | String | 是 | 企业id |  |
| `data.oper_info[].regist_date` | String | 是 | 企业注册日期 |  |
| `data.oper_info[].company_type` | String | 是 | 企业类型 |  |
| `data.oper_info[].company_status` | String | 是 | 企业经营状态 |  |
| `data.oper_info[].regist_capi` | String | 是 | 企业注册资本 |  |
| `data.oper_info[].is_history` | String | 是 | 是否历史（0：否；1：是） |  |
| `data.invest_info` | Array | 是 | 股东信息列表 |  |
| `data.invest_info[].name` | String | 是 | 自然人名称 |  |
| `data.invest_info[].pid` | String | 是 | 人员id |  |
| `data.invest_info[].oper_name` | String | 是 | 企业法人 |  |
| `data.invest_info[].oper_pid` | String | 是 | 人员id |  |
| `data.invest_info[].company` | String | 是 | 企业名称 |  |
| `data.invest_info[].eid` | String | 是 | 企业id |  |
| `data.invest_info[].credit_no` | String | 是 | 企业统一社会信用代码/注册号 |  |
| `data.invest_info[].company_type` | String | 是 | 企业类型 |  |
| `data.invest_info[].company_status` | String | 是 | 企业经营状态 |  |
| `data.invest_info[].regist_capi` | String | 是 | 企业注册资本 |  |
| `data.invest_info[].regist_date` | String | 是 | 企业注册日期 |  |
| `data.invest_info[].should_capi` | String | 是 | 认缴出资 |  |
| `data.invest_info[].percent` | String | 是 | 出资比例 |  |
| `data.invest_info[].is_history` | String | 是 | 是否历史（0：否；1：是） |  |
| `data.manager_info` | Array | 是 | 高管信息列表 |  |
| `data.manager_info[].name` | String | 是 | 自然人名称 |  |
| `data.manager_info[].pid` | String | 是 | 人员id |  |
| `data.manager_info[].oper_name` | String | 是 | 企业法人 |  |
| `data.manager_info[].oper_pid` | String | 是 | 人员id |  |
| `data.manager_info[].company` | String | 是 | 企业名称 |  |
| `data.manager_info[].credit_no` | String | 是 | 企业统一社会信用代码/注册号 |  |
| `data.manager_info[].regist_date` | String | 是 | 企业注册日期 |  |
| `data.manager_info[].eid` | String | 是 | 企业id |  |
| `data.manager_info[].company_type` | String | 是 | 企业类型 |  |
| `data.manager_info[].company_status` | String | 是 | 企业经营状态 |  |
| `data.manager_info[].regist_capi` | String | 是 | 企业注册资本 |  |
| `data.manager_info[].title` | String | 是 | 职务，多个职务中间用{;}隔开 |  |
| `data.manager_info[].is_history` | String | 是 | 是否历史（0：否；1：是） |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 2.1 工商实时信息

- Hub：`POST /api/v1/data/enterprise/2.1/query`；上游方法 GET；可调用
- 说明：更新接口触发企业工商更新，再通过数据接口获取数据。异步接口，根据此接口返回的id在“2.3 工商实时JOB状态”获取结果数据

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `province` | String | 否 | 省份缩写（参见附录B） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态，本接口返回202（创建实时任务）收费，拿到jobid在2.3接口获取数据，2.3不收费；本接口返回200（直接查得实时数据）收费。） |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.jobid` | String | 否 | 没有匹配或匹配记录不是最新：信息更新的 job id，用户可调用接口“根 据 jobid 查看企业实时更新的 job 状态” 来获取 job 状态，如果已经匹配为最新数据，则不返回该字段 |  |
| `data.name` | String | 否 | 匹配成功且公司信息最新返回以下数据字段：企业名称 |  |
| `data.id` | String | 否 | 企业id，唯一标识 |  |
| `data.econ_kind` | String | 否 | 企业类型 |  |
| `data.regist_capi` | String | 否 | 注册资本，格式：金额+万元+货币单位 |  |
| `data.actual_capi` | String | 否 | 实收资本，格式：金额+万元+货币单位 |  |
| `data.address` | String | 否 | 地址 |  |
| `data.reg_no` | String | 否 | 企业注册号 |  |
| `data.scope` | String | 否 | 经营范围 |  |
| `data.term_start` | String | 否 | 营业开始日期 |  |
| `data.term_end` | String | 否 | 营业结束日期 |  |
| `data.belong_org` | String | 否 | 所属工商局 |  |
| `data.oper_name` | String | 否 | 法人 |  |
| `data.title` | String | 否 | oper_name字段的描述信息 |  |
| `data.start_date` | String | 是 | 成立日期 |  |
| `data.end_date` | String | 是 | 注销日期 |  |
| `data.check_date` | String | 是 | 核准日期 |  |
| `data.new_status` | String | 是 | 经营状态（启信宝清洗字段） |  |
| `data.status` | String | 是 | 经营状态（工商公示状态） |  |
| `data.org_no` | String | 是 | 组织机构代码 |  |
| `data.credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.province` | String | 是 | 省份缩写（参见附录Province-code） |  |
| `data.domains` | Array | 是 | 行业，数组 |  |
| `data.branches` | Array | 是 | 分支机构 |  |
| `data.branches[].name` | String | 是 | 分支机构名称 |  |
| `data.telephone` | String | 是 | 电话 |  |
| `data.employees` | Array | 是 | 主要人员信息 |  |
| `data.employees[].job_title` | String | 是 | 主要人员职位 |  |
| `data.employees[].name` | String | 是 | 主要人员姓名 |  |
| `data.changerecords` | Array | 是 | 变更记录 |  |
| `data.changerecords[].change_item` | String | 是 | 变更项目 |  |
| `data.changerecords[].change_date` | String | 是 | 变更日期 |  |
| `data.changerecords[].before_content` | String | 是 | 变更前内容 |  |
| `data.changerecords[].after_content` | String | 是 | 变更后内容 |  |
| `data.changerecords[].u_tags` | String | 是 | 是否历史（0：非历史，1：历史） |  |
| `data.partners` | Array | 是 | 股东信息 |  |
| `data.partners[].name` | String | 是 | 股东姓名 |  |
| `data.partners[].total_real_capi` | String | 是 | 股东总实缴，格式：金额+万元+货币单位 |  |
| `data.partners[].total_should_capi` | String | 是 | 股东总认缴，格式：金额+万元+货币单位 |  |
| `data.partners[].stock_type` | String | 是 | 股东类型 |  |
| `data.partners[].identify_type` | String | 是 | 类型 |  |
| `data.partners[].identify_no` | String | 是 | ID |  |
| `data.partners[].real_capi_items` | Array | 是 | 实缴出资信息 |  |
| `data.partners[].real_capi_items[].real_capi` | String | 是 | 实缴出资额 |  |
| `data.partners[].real_capi_items[].invest_type` | String | 是 | 出资方式 |  |
| `data.partners[].real_capi_items[].real_capi_date` | String | 是 | 实缴时间 |  |
| `data.partners[].should_capi_items` | Array | 是 | 认缴出资信息 |  |
| `data.partners[].should_capi_items[].shoud_capi` | String | 是 | 认缴出资额 |  |
| `data.partners[].should_capi_items[].invest_type` | String | 是 | 出资方式 |  |
| `data.partners[].should_capi_items[].should_capi_date` | String | 是 | 出资时间 |  |
| `data.abnormal_items` | Array | 是 | 经营异常信息 |  |
| `data.abnormal_items[].in_reason` | String | 是 | 经营异常列入原因 |  |
| `data.abnormal_items[].in_date` | String | 是 | 列入日期 |  |
| `data.abnormal_items[].out_reason` | String | 是 | 移出原因 |  |
| `data.abnormal_items[].out_date` | String | 是 | 移出时间 |  |
| `data.abnormal_items[].department` | String | 是 | 处罚部门 |  |

### 2.3 工商实时JOB状态

- Hub：`POST /api/v1/data/enterprise/2.3/query`；上游方法 GET；可调用
- 说明：更新接口触发企业工商更新，再通过数据接口获取数据

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `jobid` | String | 是 | 企业信息更新的jobid如&rdquo;API_9b0d7c7d-392c-4af3-8e3b-e6ebb031f26f&rdquo; |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.regist_capi` | String | 是 | 注册资本，格式：金额+万元+货币单位 |  |
| `data.actual_capi` | String | 是 | 实收资本，格式：金额+万元+货币单位 |  |
| `data.status` | String | 是 | 在业 |  |
| `data.new_status` | String | 是 | 经营状态（清洗后状态） 1：存续；2：注销；3：吊销；4：撤销，5：迁出，6：设立中，7：清算中，8：停业，9：其他 |  |
| `data.belong_org` | String | 是 | 所属工商局 |  |
| `data.address` | String | 是 | 地址 |  |
| `data.org_no` | String | 是 | 组织机构代码 |  |
| `data.end_date` | String | 是 | 注销日期 |  |
| `data.term_end` | String | 是 | 营业结束日期 |  |
| `data.id` | String | 是 | 企业id，唯一标识 |  |
| `data.name` | String | 是 | 企业名称 |  |
| `data.employees` | Array | 是 | 主要人员信息 |  |
| `data.employees[].job_title` | String | 是 | 主要人员职位 |  |
| `data.employees[].name` | String | 是 | 主要人员姓名 |  |
| `data.partners` | Array | 是 | 股东信息 |  |
| `data.partners[].name` | String | 是 | 股东姓名 |  |
| `data.partners[].total_should_capi` | String | 是 | 股东总认缴，格式：金额+万元+货币单位 |  |
| `data.partners[].total_real_capi` | String | 是 | 股东总实缴，格式：金额+万元+货币单位 |  |
| `data.partners[].stock_type` | String | 是 | 股东类型 |  |
| `data.partners[].identify_type` | String | 是 | 类型 |  |
| `data.partners[].identify_no` | String | 是 | ID |  |
| `data.partners[].should_capi_items` | Array | 是 | 认缴出资信息 |  |
| `data.partners[].should_capi_items[].shoud_capi` | String | 是 | 认缴出资额 |  |
| `data.partners[].should_capi_items[].invest_type` | String | 是 | 出资方式 |  |
| `data.partners[].should_capi_items[].should_capi_date` | String | 是 | 出资时间 |  |
| `data.partners[].real_capi_items` | Array | 是 | 实缴出资信息 |  |
| `data.partners[].real_capi_items[].real_capi` | String | 是 | 实缴出资额 |  |
| `data.partners[].real_capi_items[].invest_type` | String | 是 | 出资方式 |  |
| `data.partners[].real_capi_items[].real_capi_date` | String | 是 | 实缴时间 |  |
| `data.oper_name` | String | 是 | 法人 |  |
| `data.title` | String | 是 | oper_name的描述信息 |  |
| `data.telephone` | String | 是 | 电话 |  |
| `data.term_start` | String | 是 | 营业开始日期 |  |
| `data.start_date` | String | 是 | 成立日期 |  |
| `data.changerecords` | Array | 是 | 变更记录 |  |
| `data.changerecords[].change_item` | String | 是 | 变更项目 |  |
| `data.changerecords[].change_date` | String | 是 | 变更日期 |  |
| `data.changerecords[].before_content` | String | 是 | 变更前内容 |  |
| `data.changerecords[].after_content` | String | 是 | 变更后内容 |  |
| `data.changerecords[].u_tags` | String | 是 | 是否历史（0：非历史，1：历史） |  |
| `data.domains` | Array | 是 | 行业，数组 |  |
| `data.abnormal_items` | Array | 是 | 经营异常信息 |  |
| `data.abnormal_items[].in_reason` | String | 是 | 经营异常列入原因 |  |
| `data.abnormal_items[].in_date` | String | 是 | 列入日期 |  |
| `data.abnormal_items[].out_reason` | String | 是 | 移出原因 |  |
| `data.abnormal_items[].out_date` | String | 是 | 移出时间 |  |
| `data.abnormal_items[].department` | String | 是 | 处罚部门 |  |
| `data.province` | String | 是 | 省份缩写（参见附录Province-code） |  |
| `data.reg_no` | String | 是 | 企业注册号 |  |
| `data.econ_kind` | String | 是 | 企业类型 |  |
| `data.check_date` | String | 是 | 核准日期 |  |
| `data.credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.scope` | String | 是 | 经营范围 |  |
| `data.branches` | Array | 是 | 分支机构 |  |
| `data.branches[].name` | String | 是 | 分支机构名称 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 60.1 小微企业-JOB申请

- Hub：`POST /api/v1/data/enterprise/60.1/query`；上游方法 GET；可调用
- 说明：根据企业名称获取小微企业信息的job id。异步接口，根据此接口返回的id在“60.2小微企业-详情数据”获取结果数据

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.jobid` | String | 是 | 小微企业信息的jobid，用户可调用接口&ldquo; 60.2小微企业-详情数据 &rdquo;来获取job状态 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 60.2 小微企业-详情数据

- Hub：`POST /api/v1/data/enterprise/60.2/query`；上游方法 GET；可调用
- 说明：小微企业详情信息，包括小微企业类型、行业、实施扶持政策的部门及日期、享受扶持政策的数额、依据及内容等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `jobid` | String | 是 | 查找小微企业的jobid如&rdquo;cd344463-a751-4f64-888b-01d497ce327a&rdquo; |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.support_department` | String | 是 | 实施扶持政策的部门 |  |
| `data.support_amount` | String | 是 | 享受扶持政策的数额 |  |
| `data.support_date` | String | 是 | 实施扶持政策日期 |  |
| `data.name` | String | 是 | 企业名称 |  |
| `data.reg_no` | String | 是 | 注册号 |  |
| `data.reg_capi` | String | 是 | 出资额 |  |
| `data.start_date` | String | 是 | 成立日期 |  |
| `data.econ_kind` | String | 是 | 企业类型 |  |
| `data.support_basis` | String | 是 | 享受扶持政策依据 |  |
| `data.credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.belong_org` | String | 是 | 登记机关 |  |
| `data.l1_domain_name` | String | 是 | 所属门类 |  |
| `data.l2_domain_name` | String | 是 | 行业 |  |
| `data.support_content` | String | 是 | 享受扶持政策内容 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 42.1 附近企业查询

- Hub：`POST /api/v1/data/enterprise/42.1/query`；上游方法 GET；可调用
- 说明：目标企业附近企业列表，包括附近企业总数、企业名称以及经纬度等信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |
| `distance` | Number | 是 | 搜索范围（单位：KM） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 附近企业信息列表 |  |
| `data.items[].start_date` | String | 是 | 成立日期 |  |
| `data.items[].oper_name` | String | 是 | 法定代表人 |  |
| `data.items[].id` | String | 是 | 企业ID |  |
| `data.items[].name` | String | 是 | 企业名称 |  |
| `data.items[].latitude` | Number | 是 | 纬度 |  |
| `data.items[].longitude` | Number | 是 | 经度 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 42.3 周边企业总数

- Hub：`POST /api/v1/data/enterprise/42.3/query`；上游方法 POST；可调用
- 说明：根据坐标查询周边企业总数

**body 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `longitude` | Number | 是 | 中心点经度（高德地图）入参放在 body 里 |
| `latitude` | Number | 是 | 中心点纬度（高德地图）入参放在 body 里 |
| `radius` | Number | 是 | 距离半径支持：1,3,5,10，单位默认为公 里，入参放在 body 里 |
| `industry` | String | 否 | 行业代码（选填,行业代码和名称对应表 见附录），入参放在 body 里 |
| `regist_capi` | String | 否 | 注册资本范围（选填，以下划线连接的行 业范围，默认单位为万元） 0_100：表示 0 万 - 100 万 100_200：表示 100 万 - 200 万 200_500：表示 200 万 - 500 万 500_1000：表示 500 万 - 1000 万 1000_5000：表示 1000 万 - 5000 万 5000_10000：表示 5000 万 – 1 亿 10000_: 表示 1 亿以上 入参放在 body 里 |
| `status` | String | 否 | 经营状态（选填） live ：营业中, abnormal: 开业经营异常, revoked: 吊销, writenoff: 注销, clearing: 清算中, movein: 迁入, cancelled : 撤销, closed: 停业, registering: 筹建, expired: 经营期限届满, writingoff: 拟注销, other: 其他 入参放在 body 里 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 企业总数 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 42.4 周边企业详情

- Hub：`POST /api/v1/data/enterprise/42.4/query`；上游方法 POST；可调用
- 说明：目标区域附近的企业总数和列表

**body 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `longitude` | Number | 是 | 中心点经度（高德地图）入参放在 body 里 |
| `latitude` | Number | 是 | 中心点纬度（高德地图）入参放在 body里 |
| `radius` | Number | 是 | 距离半径支持：1,3,5,10，单位默认为公 里，入参放在 body 里，单位：KM |
| `industry` | String | 否 | 行业代码（选填,仅支持一二级行业的传入,行业代码和名称对应表 见附录），入参放在 body 里 |
| `regist_capi` | String | 否 | 注册资本范围（选填，以下划线连接的行 业范围，默认单位为万元） 0_100：表示 0 万 - 100 万 100_200：表示 100 万 - 200 万 200_500：表示 200 万 - 500 万 500_1000：表示 500 万 - 1000 万 1000_5000：表示 1000 万 - 5000 万 5000_10000：表示 5000 万 – 1 亿 10000_: 表示 1 亿以上 入参放在 body 里 |
| `status` | String | 否 | 经营状态（选填，支持多选，多选时为 or 的关系，例如输入”1,2”,只要属于 1 或 者 2 的企业都输出） 1：存续；2：注销；3：吊销；4：撤销， 5：迁出，6：设立中，7：清算中，8：停 业，9：其他 string：以半角逗号分隔的字符串 入参放在 body 里 |
| `skip` | String | 否 | 跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 企业总数 |  |
| `data.num` | Number | 是 | 当前返回的条数 |  |
| `data.items` | Array | 是 | 企业列表 |  |
| `data.items[].start_date` | String | 是 | 成立日期 |  |
| `data.items[].oper_name` | String | 是 | 企业法定代表人 |  |
| `data.items[].id` | String | 是 | 企业编号 |  |
| `data.items[].industry` | String | 是 | 行业 |  |
| `data.items[].name` | String | 是 | 企业名称 |  |
| `data.items[].status` | String | 是 | 经营状态（旧字段，不建议使用） |  |
| `data.items[].new_status` | String | 是 | 经营状态（清洗后状态） 1：存续；2：注销；3：吊销；4：撤销，5：迁出，6：设立中，7：清算中，8：停业，9：其他 |  |
| `data.items[].distance` | String | 是 | 距离，单位：M米 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 42.9 企业坐标

- Hub：`POST /api/v1/data/enterprise/42.9/query`；上游方法 GET；可调用
- 说明：企业坐标信息，包括高德地图和百度地图对应企业经纬度信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `type` | Number | 否 | 坐标类型（若不填写本字段，则默认0） 0：百度地图 1：高德地图 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.eid` | String | 是 | 企业ID |  |
| `data.latitude` | Number | 是 | 纬度 |  |
| `data.name` | String | 是 | 企业名称 |  |
| `data.type` | Number | 是 | 坐标类型 0：百度地图 1：高德地图 |  |
| `data.longitude` | Number | 是 | 经度 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 93.16 企业工商风险扫描

- Hub：`POST /api/v1/data/enterprise/93.16/query`；上游方法 GET；可调用
- 说明：获取企业自身风险信息条数，返回工商股东、主要人员、变更记录、分支机构、行政处罚、环保处罚列表、动产抵押、股权出质、股权冻、司法协助、经营异常、严重违法、抽查检查、招投标列表、招聘信息、行政许可、债券基础信息、工程资质资格、高新技术企业资质、欠税信息、重大税收违法、非正常户、对外投资（最优股比）等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.xzcf_count` | Number | 是 | 行政处罚数量 |  |
| `data.dcdy_count` | Number | 是 | 动产抵押数量 |  |
| `data.gsgd_count` | Number | 是 | 工商股东数量 |  |
| `data.total_count` | Number | 是 | 所有信息数量 |  |
| `data.ccjc_count` | Number | 是 | 抽查检查数量 |  |
| `data.xzxk_count` | Number | 是 | 行政许可数量 |  |
| `data.sswf_count` | Number | 是 | 重大税收违法数量 |  |
| `data.sfxz_count` | Number | 是 | 司法协助数量 |  |
| `data.zqxx_count` | Number | 是 | 债券基础信息数量 |  |
| `data.zpxx_count` | Number | 是 | 招聘信息数量 |  |
| `data.gqdj_count` | Number | 是 | 股权冻结数量 |  |
| `data.zyry_count` | Number | 是 | 主要人员数量 |  |
| `data.hbcf_count` | Number | 是 | 环保处罚列表数量 |  |
| `data.bgjl_count` | Number | 是 | 变更记录数量 |  |
| `data.dwtz_count` | Number | 是 | 对外投资数量（最优股比） |  |
| `data.fzch_count` | Number | 是 | 非正常户数量 |  |
| `data.qsxx_count` | Number | 是 | 欠税信息数量 |  |
| `data.jyyc_count` | Number | 是 | 经营异常数量 |  |
| `data.yzwf_count` | Number | 是 | 严重违法数量 |  |
| `data.fzjg_count` | Number | 是 | 分支机构数量 |  |
| `data.gczz_count` | Number | 是 | 工程资质资格数量 |  |
| `data.gxqy_count` | Number | 是 | 高新技术企业资质数量 |  |
| `data.gqcz_count` | Number | 是 | 股权出质数量 |  |
| `data.ztb_count` | Number | 是 | 招投标列表数量 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 93.17 企业关联信息汇总

- Hub：`POST /api/v1/data/enterprise/93.17/query`；上游方法 GET；可调用
- 说明：企业关联信息及其他风险信息条数，包括关联企业、受益所有人、实际控制企业、税务异常、司法拍卖、清算信息、破产案件等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.qsxx_count` | Number | 是 | 清算信息数量 |  |
| `data.swyc_count` | Number | 是 | 税务异常数量 |  |
| `data.sfpm_count` | Number | 是 | 司法拍卖数量 |  |
| `data.total_count` | Number | 是 | 所有信息数量 |  |
| `data.bgjl_count` | Number | 是 | 实际控制企业数量 |  |
| `data.glqy_count` | Number | 是 | 关联企业数量 |  |
| `data.sysyl_count` | Number | 是 | 受益所有人数量 |  |
| `data.pcaj_count` | Number | 是 | 破产案件数量 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 79.11 企业性质（资本背景）

- Hub：`POST /api/v1/data/enterprise/79.11/query`；上游方法 GET；可调用
- 说明：根据企业全名/注册号/统一社会信用代码获得企业规模资本背景。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.tag_code` | String | 是 | 企业性质代码 |  |
| `data.tag_name` | String | 是 | 企业性质（资本背景），该字段返回客户的通过资本背景计算的企业性质 |  |
| `data.tag_items` | Array | 是 | 企业性质，该数组返回查询企业的全部性质 |  |
| `data.tag_items[].tag_code` | String | 是 | 企业性质代码 |  |
| `data.tag_items[].tag_name` | String | 是 | 企业性质 |  |
| `sign` | string | 是 | 数据签名 |  |
| `status` | string | 是 | 接口调用状态 |  |
| `message` | string | 是 | 返回结果消息 |  |

### 79.12 企业规模

- Hub：`POST /api/v1/data/enterprise/79.12/query`；上游方法 GET；可调用
- 说明：根据企业全名/注册号/统一社会信用代码获得企业规模。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.tag_code` | String | 是 | 企业规模代码 |  |
| `data.tag_name` | String | 是 | 企业规模（微型企业/小型企业/中型企业/大型企业/疑似微型企业/疑似小型企业） |  |
| `sign` | string | 是 | 数据签名 |  |
| `status` | string | 是 | 返回结果状态 |  |
| `message` | string | 是 | 返回结果消息 |  |

### 79.13 企业行业（国民经济分类）

- Hub：`POST /api/v1/data/enterprise/79.13/query`；上游方法 GET；可调用
- 说明：根据企业全名/注册号/统一社会信用代码获得企业国民经济行业分类

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.level` | String | 是 | 行业分类级别 |  |
| `data.industry_code` | String | 是 | 行业分类代码 |  |
| `data.industry_name` | String | 是 | 行业分类（国民经济分类） |  |
| `industry_code_l1` | String | 是 | 一级行业代码 |  |
| `industry_name_l1` | String | 是 | 一级行业名称 |  |
| `industry_code_l2` | String | 是 | 二级行业代码 |  |
| `industry_name_l2` | String | 是 | 二级行业名称 |  |
| `industry_code_l3` | String | 是 | 三级行业代码 |  |
| `industry_name_l3` | String | 是 | 三级行业名称 |  |
| `industry_code_l4` | String | 是 | 四级行业代码 |  |
| `industry_name_l4` | String | 是 | 四级行业名称 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 79.34 企业三码

- Hub：`POST /api/v1/data/enterprise/79.34/query`；上游方法 GET；可调用
- 说明：根据企业全名获得统一社会信用代码、组织机构代码、注册号。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 企业列表 |  |
| `data.items[].ename` | String | 是 | 企业全称（现用名） |  |
| `data.items[].credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.items[].org_no` | String | 是 | 组织机构代码 |  |
| `data.items[].reg_no` | String | 是 | 注册号 |  |
| `data.items[].status` | String | 是 | 企业状态 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 79.26 企业迁移情况

- Hub：`POST /api/v1/data/enterprise/79.26/query`；上游方法 GET；可调用
- 说明：企业迁移情况，包括迁移日期，迁出迁入的地址、省份、城市、区域等信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数(返回上限100条) |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 迁移记录列表 |  |
| `data.items[].from_address` | String | 是 | 迁出地址 |  |
| `data.items[].from_city` | String | 是 | 迁出城市 |  |
| `data.items[].from_region` | String | 是 | 迁出区域 |  |
| `data.items[].move_date` | String | 是 | 迁移日期 |  |
| `data.items[].from_province` | String | 是 | 迁出省份 |  |
| `data.items[].to_region` | String | 是 | 迁入区域 |  |
| `data.items[].to_province` | String | 是 | 迁入省份 |  |
| `data.items[].to_address` | String | 是 | 迁入地址 |  |
| `data.items[].to_city` | String | 是 | 迁入城市 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 24.28 企业历史名称

- Hub：`POST /api/v1/data/enterprise/24.28/query`；上游方法 GET；可调用
- 说明：企业历史名称信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | String | 否 | 分页跳过的记录数（默认为0）分页20 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].eid` | String | 是 | 企业eid |  |
| `data.items[].date` | String | 是 | 变更时间 |  |
| `data.items[].history_name` | String | 是 | 历史公司名 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 21.47 减资公告

- Hub：`POST /api/v1/data/enterprise/21.47/query`；上游方法 GET（可选 GET/POST）；可调用
- 说明：根据企业名称获取公告内容、做出决定日期、公告日期等企业减资公告信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].ename` | String | 是 | 企业名 |  |
| `data.items[].eid` | String | 是 | 企业eid |  |
| `data.items[].credit_no` | String | 是 | 统一社会代码 |  |
| `data.items[].determine_date` | String | 是 | 做出决定日期 |  |
| `data.items[].notice_date` | String | 是 | 公告日期（排序字段，降序排列） |  |
| `data.items[].notice_period_start` | String | 是 | 公告开始时间 |  |
| `data.items[].notice_period_end` | String | 是 | 公告结束时间 |  |
| `data.items[].content` | String | 是 | 公告内容 |  |
| `data.items[].u_tags` | String | 是 | 是否历史 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 91.66 企业主体性质（司库）

- Hub：`POST /api/v1/data/enterprise/91.66/query`；上游方法 GET；可调用
- 说明：根据企业名称获取企业主体性质，具体类型包括：中央企业、地方国有企业、中央部委、地方政府、民营企业、其他、事业单位、个体工商户

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 |  |  |
| `data.type_id` | String | 是 | 标签id |  |
| `data.credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.type_name` | String | 是 | 标签名称（K01：中央企业 K02：地方国有企业 K03：中央部委 K04：地方政府 K05：民营企业 K06: 其他 K07：事业单位 K08：个体工商户） |  |
| `data.name` | String | 是 | 企业名称 |  |
| `data.format_name` | String | 是 | 标准名称 |  |

### 64.13 规上企业

- Hub：`POST /api/v1/data/enterprise/64.13/query`；上游方法 GET（可选 GET/POST）；可调用
- 说明：查询规上企业相关信息，包括企业行业分类，法定代表人，成立日期，注册资本，公司类型，经营状态，统一社会信用代码，经营范围等信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.industry_category` | String | 是 | 行业分类 |  |
| `data.ename` | String | 是 | 企业名称 |  |
| `data.eid` | String | 是 | 企业ID |  |
| `data.oper_name` | String | 是 | 法定代表人 |  |
| `data.start_date` | String | 是 | 成立日期 |  |
| `data.regist_capi` | String | 是 | 注册资本 |  |
| `data.econ_kind` | String | 是 | 公司类型 |  |
| `data.status` | String | 是 | 经营状态 |  |
| `data.district_code` | String | 是 | 最优区域码 |  |
| `data.credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.scope` | String | 是 | 经营范围 |  |

### 51.39 小微企业

- Hub：`POST /api/v1/data/enterprise/51.39/query`；上游方法 GET；可调用
- 说明：获取企业是否小微企业及小微企业相关信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 否 | 返回结果状态 |  |
| `message` | String | 否 | 返回结果消息 |  |
| `sign` | String | 否 | 数据签名 |  |
| `data` | Object | 否 | 数据 |  |
| `data.reg_no` | String | 否 | 注册号 |  |
| `data.credit_no` | String | 否 | 统一社会信用代码 |  |
| `data.reg_capi` | String | 否 | 注册资金 |  |
| `data.econ_kind` | String | 否 | 企业类型 |  |
| `data.belong_org` | String | 否 | 登记机关 |  |
| `data.start_date` | String | 否 | 成立日期 |  |
| `data.l1_domain_name` | String | 否 | 所属门类 |  |
| `data.l2_domain_name` | String | 否 | 行业 |  |
| `data.support_department` | String | 否 | 实施扶持的部门 |  |
| `data.support_date` | String | 否 | 实施扶持的日期 |  |
| `data.support_basis` | String | 否 | 享受扶持的依据 |  |
| `data.support_content` | String | 否 | 享受扶持的内容 |  |
| `data.support_count` | String | 否 | 享受扶持的数额 |  |
| `data.support_infos` | String | 否 | 享受扶持的政策信息 |  |
| `data.is_history` | String | 否 | 是否历史 |  |

### 77.58 医院信息

- Hub：`POST /api/v1/data/enterprise/77.58/query`；上游方法 GET；可调用
- 说明：医院信息查询，包括登记证号、法定代表人/负责人等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 当前返回列表中的数据量 |  |
| `data.items` | Array | 是 | 返回列表 |  |
| `data.items[].id` | String | 是 | 医院ID |  |
| `data.items[].hospital_name` | String | 是 | 医院名称 |  |
| `data.items[].province` | String | 是 | 省份 |  |
| `data.items[].department` | String | 是 | 审批/备案机关 |  |
| `data.items[].number` | String | 是 | 登记号 |  |
| `data.items[].address` | String | 是 | 地址 |  |
| `data.items[].medical_subjects` | String | 是 | 诊疗科目 |  |
| `data.items[].level` | String | 是 | 级别 |  |
| `data.items[].oper_name` | String | 是 | 法人 |  |
| `data.items[].person` | String | 是 | 负责人 |  |
| `data.items[].license_start_date` | String | 是 | 执业许可证开始日期 |  |
| `data.items[].license_end_date` | String | 是 | 执业许可证结束日期 |  |
| `data.items[].is_history` | Number | 是 | 是否历史，0否1是 |  |
| `data.items[].ownership_form` | String | 是 | 所有制形式 |  |
| `data.items[].business_type` | String | 是 | 经营性质 |  |
| `data.items[].service_mode` | String | 是 | 服务方式 |  |
| `data.items[].record_date` | String | 是 | 备案日期 |  |

### 77.51 企业历史法人

- Hub：`POST /api/v1/data/enterprise/77.51/query`；上游方法 GET；可调用
- 说明：企业历史法人信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | String | 否 | 分页跳过的记录数（默认为0）分页20 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].ename` | String | 是 | 企业名称 |  |
| `data.items[].pname` | String | 是 | 法人名称 |  |
| `data.items[].start_date` | String | 是 | 法人任职开始时间 |  |
| `data.items[].end_date` | String | 是 | 法人任职结束时间 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

## 司法风险


### 47.4 立案信息

- Hub：`POST /api/v1/data/enterprise/47.4/query`；上游方法 GET；可调用
- 说明：企业立案信息，包括立案ID、开庭日期、案件状态、承办人、当事人等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 立案信息列表 |  |
| `data.items[].hearing_date` | String | 是 | 开庭日期 |  |
| `data.items[].related_items` | Array | 是 | 案件关联信息 |  |
| `data.items[].related_items[].role` | String | 是 | 当事人 |  |
| `data.items[].related_items[].items` | Array | 是 | 立案当事人信息 |  |
| `data.items[].related_items[].items[].eid` | String | 是 | 当事人企业id |  |
| `data.items[].related_items[].items[].name` | String | 是 | 当事人企业名称 |  |
| `data.items[].related_items[].items[].entity_type` | String | 是 | 当事人类型（0： 企业，4：社会组织，5：律所） |  |
| `data.items[].start_date` | String | 是 | 立案时间 |  |
| `data.items[].assistant` | String | 是 | 助理法官 |  |
| `data.items[].case_cause` | String | 是 | 案由 |  |
| `data.items[].case_status` | String | 是 | 案件状态 |  |
| `data.items[].case_no` | String | 是 | 案号 |  |
| `data.items[].end_date` | String | 是 | 结束时间 |  |
| `data.items[].agent` | String | 是 | 承办人 |  |
| `data.items[].case_id` | String | 是 | 立案id |  |
| `data.items[].court` | String | 是 | 法院 |  |
| `data.items[].url` | String | 是 | 数据源链接（字段废弃） | 🔗 |
| `data.items[].standard_case_status` | String | 是 | 标准案件状态 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 17.5 被执行企业

- Hub：`POST /api/v1/data/enterprise/17.5/query`；上游方法 GET；可调用
- 说明：企业被执行信息，包括执行ID、执行状态、执行金额、立案日期等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].id` | String | 是 | 执行ID |  |
| `data.items[].case_number` | String | 是 | 案号 |  |
| `data.items[].status` | String | 是 | 执行状态, 0为执行中，1为已结案，-为未知 |  |
| `data.items[].court` | String | 是 | 执行法院 |  |
| `data.items[].case_date` | String | 是 | 立案日期 |  |
| `data.items[].amount` | String | 是 | 执行金额，单位：元，人民币 |  |
| `data.items[].disabled` | String | 是 | 0：当前公示信息；1：历史公示信息 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 5.5 失信被执行企业

- Hub：`POST /api/v1/data/enterprise/5.5/query`；上游方法 GET；可调用
- 说明：企业失信信息，包括执行法院、法定代表人、被执行人履行情况及行为具体情形等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 失信人信息列表 |  |
| `data.items[].province` | String | 是 | 省份 |  |
| `data.items[].date` | String | 是 | 立案时间 |  |
| `data.items[].doc_number` | String | 是 | 执行依据文号 |  |
| `data.items[].final_duty` | String | 是 | 生效法律文书确定的义务 |  |
| `data.items[].execution_status` | String | 是 | 被执行人履行情况 |  |
| `data.items[].case_number` | String | 是 | 案号 |  |
| `data.items[].amount` | String | 是 | 执行标的 |  |
| `data.items[].publish_date` | String | 是 | 发布日期 |  |
| `data.items[].court` | String | 是 | 执行法院 |  |
| `data.items[].execution_desc` | String | 是 | 失信被执行人行为具体情形 |  |
| `data.items[].disabled` | String | 是 | 0：当前公示信息；1：历史公示信息 |  |
| `data.items[].oper_name` | String | 是 | 法定代表人 |  |
| `data.items[].number` | String | 是 | 组织机构号 |  |
| `data.items[].ex_department` | String | 是 | 做出执行依据单位 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 19.1 开庭公告

- Hub：`POST /api/v1/data/enterprise/19.1/query`；上游方法 GET；可调用
- 说明：企业开庭公告，包括法庭、开庭日期、案号、案由、原告、被告等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 开庭公告列表 |  |
| `data.items[].defendant` | String | 是 | 被告 |  |
| `data.items[].plaintiff` | String | 是 | 原告 |  |
| `data.items[].pure_role` | String | 是 | 当事人身份 |  |
| `data.items[].department` | String | 是 | 承办部门 |  |
| `data.items[].court` | String | 是 | 法庭 |  |
| `data.items[].case_no` | String | 是 | 案号 |  |
| `data.items[].judge` | String | 是 | 审判长/主审人 |  |
| `data.items[].disabled` | Number | 是 | 0：当前公示信息；1：历史公示信息 |  |
| `data.items[].case_reason` | String | 是 | 案由 |  |
| `data.items[].hearing_date` | String | 是 | 开庭日期 |  |
| `data.items[].related_companies` | Array | 是 | 当事人 |  |
| `data.items[].related_companies[].role` | String | 是 | 角色 |  |
| `data.items[].related_companies[].item` | String | 是 | 企业eid |  |
| `data.items[].related_companies[].name` | String | 是 | 名称 |  |
| `data.items[].related_companies[].type（E：企业；P：个人）` | String | 是 | 类型 |  |
| `data.items[].related_companies[].pure_role` | String | 是 | 身份 |  |
| `data.items[].url` | String | 是 | 数据源链接 | 🔗 |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 9.1 法院公告

- Hub：`POST /api/v1/data/enterprise/9.1/query`；上游方法 GET；可调用
- 说明：企业法院公告，包括公告类型、内容、发布日期、当事人等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 法院公告信息列表 |  |
| `data.items[].court` | String | 是 | 法院 |  |
| `data.items[].disabled` | String | 是 | 是否历史，0：当前公示信息；1：历史公示信息 |  |
| `data.items[].content` | String | 是 | 内容 |  |
| `data.items[].date` | String | 是 | 发布日期 |  |
| `data.items[].person` | String | 是 | 当事人 |  |
| `data.items[].role` | String | 是 | 当事人身份 |  |
| `data.items[].type` | String | 是 | 公告类型，1 起诉状副本及开庭传票 2 裁判文书 3 送达公告 4 执行文书 5 起诉状、上诉状副本 6 开庭传票 7 公示催告 8 更正 9 破产文书 10 宣告失踪、死亡 11 仲裁文书 12 清算公告 13 拍卖公告 14 司法鉴定书 15 遗失声明 16 公益诉讼 17 海事文书 18 无主财产认领公告 19 行政处罚通知书 20 其他 |  |
| `data.items[].standard_case_no` | String | 是 | 案号 |  |
| `data.items[].case_reasons` | Array | 是 | 标准案由信息 |  |
| `data.items[].case_reasons[].standard_case_reason` | String | 是 | 标准案由 |  |
| `data.items[].case_reasons[].case_reason_code` | String | 是 | 标准案由代码 |  |
| `data.items[].related_companies` | Array | 是 | 关联企业/个人 |  |
| `data.items[].related_companies[].role` | String | 是 | 角色 |  |
| `data.items[].related_companies[].type` | String | 是 | 类型 |  |
| `data.items[].related_companies[].by` | String | 是 | 来源 |  |
| `data.items[].related_companies[].name` | String | 是 | 名称 |  |
| `data.items[].related_companies[].item` | String | 是 | 关联企业匹配到的企业ID |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 62.89 送达公告

- Hub：`POST /api/v1/data/enterprise/62.89/query`；上游方法 GET；可调用
- 说明：送达公告，包括法庭、案号、案由、详情等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 分页跳过的记录数（默认为0）分页20 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].eid` | String | 是 | 企业id |  |
| `data.items[].clean_role` | String | 是 | 当事人角色 |  |
| `data.items[].related_companies` | Array | 是 | 关联企业/个人 |  |
| `data.items[].related_companies[].clean_role` | String | 是 | 角色 |  |
| `data.items[].related_companies[].type` | String | 是 | 类型 |  |
| `data.items[].related_companies[].name` | String | 是 | 名称 |  |
| `data.items[].related_companies[].item` | String | 是 | 关联企业匹配到的企业ID |  |
| `data.items[].standard_case_no` | String | 是 | 案号 |  |
| `data.items[].title` | String | 是 | 公告名称 |  |
| `data.items[].case_reason` | String | 是 | 案由 |  |
| `data.items[].date` | String | 是 | 发布时间 |  |
| `data.items[].object_id` | String | 是 | 公告详情id |  |
| `data.items[].court` | String | 是 | 法院 |  |
| `data.items[].content` | String | 是 | 详情 |  |
| `data.items[].url` | String | 是 | 详情页链接 | 🔗 |
| `data.items[].disabled` | String | 是 | 是否历史，0：当前公示信息；1：历史公示信息 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 6.5 行贿违法

- Hub：`POST /api/v1/data/enterprise/6.5/query`；上游方法 GET；可调用
- 说明：企业行贿违法类裁判文书，包括判决基本信息及链接等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 法院判决信息列表 |  |
| `data.items[].date` | String | 是 | 判决时间 |  |
| `data.items[].defendants` | Array | 是 | 被告 |  |
| `data.items[].pub_date` | String | 是 | 发布日期 |  |
| `data.items[].title` | String | 是 | 标题 |  |
| `data.items[].case_cause` | String | 是 | 案由 |  |
| `data.items[].sub_amount` | String | 是 | 判决金额​ |  |
| `data.items[].disabled` | String | 是 | 0：当前公示信息；1：历史公示信息 |  |
| `data.items[].court` | String | 是 | 法院 |  |
| `data.items[].judgeresult` | String | 是 | 判决结果 |  |
| `data.items[].url` | String | 是 | 链接 | 🔗 |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 66.1 限制高消费

- Hub：`POST /api/v1/data/enterprise/66.1/query`；上游方法 GET；可调用
- 说明：企业限制高消费信息，包括限制高消费企业信息、案由等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `ename` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `pname` | String | 否 | 董监高姓名 |
| `skip` | Number | 否 | 跳过条目数(默认为0，单页返回20条数据) |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 企业限制高消费信息列表 |  |
| `data.items[].tag` | String | 是 | 是否历史1-是0-否 |  |
| `data.items[].caseNo` | String | 是 | 案号 |  |
| `data.items[].name` | String | 是 | 限制高消费人 |  |
| `data.items[].content` | String | 是 | 限消正文 |  |
| `data.items[].sex` | String | 是 | 性别 |  |
| `data.items[].court` | String | 是 | 执行法院 |  |
| `data.items[].executionApplicant` | String | 是 | 申请执行人 |  |
| `data.items[].caseReason` | String | 是 | 案由 |  |
| `data.items[].courtCode` | String | 是 | 法院码 |  |
| `data.items[].stdCourtName` | String | 是 | 标准法院名称 |  |
| `data.items[].courtDistrictCode` | String | 是 | 执行法院区域码 |  |
| `data.items[].stdCaseNo` | String | 是 | 标准案号 |  |
| `data.items[].companyId` | String | 是 | 企业id |  |
| `data.items[].companyName` | String | 是 | 限消人企业 |  |
| `data.items[].filingDate` | String | 是 | 立案时间 |  |
| `data.items[].stdCaseReasons` | Array | 是 | 标准案由信息 |  |
| `data.items[].stdCaseReasons[].stdCasereason` | String | 是 | 标准案由 |  |
| `data.items[].stdCaseReasons[].caseReasonCode` | String | 是 | 案由代码 |  |
| `data.items[].releaseDate` | String | 是 | 限制令发布日期 |  |
| `data.items[].relatedCompanies` | Array | 是 | 关联企业/个人 |  |
| `data.items[].relatedCompanies[].role` | String | 是 | 角色 |  |
| `data.items[].relatedCompanies[].cleanRole` | String | 是 | 标准角色 |  |
| `data.items[].relatedCompanies[].type` | String | 是 | 类型 |  |
| `data.items[].relatedCompanies[].name` | String | 是 | 名称 |  |
| `data.items[].relatedCompanies[].eid` | String | 是 | 企业id |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 7.1 司法拍卖

- Hub：`POST /api/v1/data/enterprise/7.1/query`；上游方法 GET；可调用
- 说明：企业司法拍卖信息，包括拍品介绍、起拍价、拍卖日期等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 司法拍卖信息列表 |  |
| `data.items[].name` | String | 是 | 工商名称 |  |
| `data.items[].full_name` | String | 是 | 企业名称 |  |
| `data.items[].object_name` | String | 是 | 标的物 |  |
| `data.items[].project_name` | String | 是 | 项目名称 |  |
| `data.items[].restrict` | String | 是 | 权利限制情况 |  |
| `data.items[].basis` | String | 是 | 权利来源 |  |
| `data.items[].description` | String | 是 | 拍品介绍 |  |
| `data.items[].court` | String | 是 | 处置法院 |  |
| `data.items[].start_price` | String | 是 | 起拍价 |  |
| `data.items[].date` | String | 是 | 拍卖日期 |  |
| `data.items[].transaction_date` | String | 是 | 交易时间 |  |
| `data.items[].case_no` | String | 是 | 案号 |  |
| `data.items[].transaction_price` | String | 是 | 交易价格 |  |
| `data.items[].est_price` | String | 是 | 评估价 |  |
| `data.items[].role` | String | 是 | 角色（被执行人，拍品所有人，使用权人，债权人） |  |
| `data.items[].bond_price` | String | 是 | 保证金 |  |
| `data.items[].add_price` | String | 是 | 加价幅度 |  |
| `data.items[].auction_status` | String | 是 | 拍卖状态 |  |
| `data.items[].auction_status_code` | Number | 是 | 状态码值（0：其他；1：即将开始；2：正在进行；3：拍卖成功；4：拍卖失败；5：拍卖停止。） |  |
| `data.items[].auction_stage` | String | 是 | 拍卖阶段 |  |
| `data.items[].auction_stage_code` | Number | 是 | 阶段码值（1：一拍、2：二拍、3：三拍、4：变卖、5：重拍、6：其他） |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 51.4 破产案件

- Hub：`POST /api/v1/data/enterprise/51.4/query`；上游方法 GET（可选 GET/POST）；可调用
- 说明：破产案件信息，包括案件号、案件类型、申请人、被申请人及管理机构等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 破产案件信息列表 |  |
| `data.items[].app_name_eid` | String | 是 | 申请人id |  |
| `data.items[].disabled` | Number | 是 | 0：当前公示信息；1：历史公示信息 |  |
| `data.items[].name` | String | 是 | 被申请人 |  |
| `data.items[].case_kind` | String | 是 | 案件类型（1破产审查案件、2破产案件、3强制清算申请审查案件、4强制清算案件、5强制清算上诉案件、6破产上诉案件、7破产监督案件为破产案件、8强制清算监督案件为强制清算） |  |
| `data.items[].management_agency_eid` | String | 是 | 管理人机构eid |  |
| `data.items[].court` | String | 是 | 法院 |  |
| `data.items[].id` | String | 是 | 案件id |  |
| `data.items[].pub_date` | String | 是 | 公开时间 |  |
| `data.items[].case_no` | String | 是 | 案件号 |  |
| `data.items[].agency_principal` | String | 是 | 管理人主要负责人 |  |
| `data.items[].name_eid` | String | 是 | 被申请人id |  |
| `data.items[].app_name` | String | 是 | 申请人 |  |
| `data.items[].management_agency` | String | 是 | 管理人机构 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 51.5 破产公告

- Hub：`POST /api/v1/data/enterprise/51.5/query`；上游方法 GET；可调用
- 说明：破产公告信息，包括公告标题、公告类型、公开时间及正文等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | String | 是 | 案件id |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.id` | String | 是 | 案件 id |  |
| `data.notice_kind` | String | 是 | 公告类型（备注），1.0 公开公告 、1.1 招募投资公告、 1.2 招募管理人公告、 1.3 案件公告 1.4 拍卖公告、 1.5 其他公告、 1.6 债权人会议公告、 1.7 预重整公告、 1.8 重整计划公告、 2.0 裁判文书 |  |
| `data.notice_title` | String | 是 | 公告标题 |  |
| `data.case_no` | String | 是 | 案号 |  |
| `data.case_title` | String | 是 | 案件标题 |  |
| `data.pub_date` | String | 是 | 公开时间 |  |
| `data.pub_people` | String | 是 | 公开人 |  |
| `data.pub_people_eid` | String | 是 | 公开人 eid |  |
| `data.content` | String | 是 | 正文 |  |
| `data.pdf` | String | 是 | 附件 | 🔗 |
| `data.disabled` | Number | 是 | 0：当前公示信息；1：历史公示信息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 61.75 询价评估

- Hub：`POST /api/v1/data/enterprise/61.75/query`；上游方法 GET（可选 GET/POST）；可调用
- 说明：查询企业是否存在询价评估的情况。返回包括但不限于案号、标的物、询价结果、评估内容等信息。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `type` | String | 否 | 0：评估结果；1：选定评估机构。当为空时，不对type限制 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].subject_matter` | String | 是 | 标的物名称 |  |
| `data.items[].subject_matter_people` | Array | 是 | 标的物所有人 |  |
| `data.items[].subject_matter_people[].type` | String | 是 | 标的物所有人类型，P个人，E企业 |  |
| `data.items[].subject_matter_people[].name` | String | 是 | 标的物所有人 |  |
| `data.items[].subject_matter_people[].eid` | String | 是 | 标的物所有人eid |  |
| `data.items[].property_kind` | String | 是 | 财产类型 |  |
| `data.items[].type` | String | 是 | 类型（0：评估结果；1：选定评估机构） |  |
| `data.items[].ename` | String | 是 | 被执行人名称 |  |
| `data.items[].case_no` | String | 是 | 案号 |  |
| `data.items[].court_name` | String | 是 | 法院名称 |  |
| `data.items[].evaluation_institution` | Array | 是 | 选定评估机构 |  |
| `data.items[].evaluation_institution[].eid` | String | 是 | 评估机构eid |  |
| `data.items[].evaluation_institution[].name` | String | 是 | 评估机构名称 |  |
| `data.items[].evaluation_institution[].type` | String | 是 | 评估机构类型 |  |
| `data.items[].lottery_time` | String | 是 | 摇号日期 |  |
| `data.items[].result` | Array | 是 | 询价结果 |  |
| `data.items[].result[].price` | String | 是 | 询价结果价格 |  |
| `data.items[].result[].type` | String | 是 | 询价结果出具类型，P个人，E企业 |  |
| `data.items[].result[].name` | String | 是 | 询价结果出具企业名称 |  |
| `data.items[].result[].eid` | String | 是 | 询价结果出具企业eid |  |
| `data.items[].pub_date` | String | 是 | 发布日期 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 98.98 限制出境核查

- Hub：`POST /api/v1/data/enterprise/98.98/query`；上游方法 GET；可调用
- 说明：根据企业名称获取企业限制出境对象情况，包括被执行人地址、执行案由、承办法院等相关信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页20条） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].name` | String | 是 | 企业名称 |  |
| `data.items[].eid` | String | 是 | 企业id |  |
| `data.items[].pname` | String | 是 | 限制出境对象 |  |
| `data.items[].address` | String | 是 | 被执行人地址 |  |
| `data.items[].case_no` | String | 是 | 案号 |  |
| `data.items[].execution_applicant` | String | 是 | 申请执行人 |  |
| `data.items[].amount` | String | 是 | 执行标的金额 |  |
| `data.items[].court` | String | 是 | 承办法院 |  |
| `data.items[].publish_date` | String | 是 | 发布日期 |  |
| `data.items[].case_reason` | String | 是 | 执行案由 |  |
| `data.items[].filing_date` | String | 是 | 立案时间 |  |
| `data.items[].is_history` | String | 是 | 是否历史 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 6.6 整体诉讼

- Hub：`POST /api/v1/data/enterprise/6.6/query`；上游方法 GET；可调用
- 说明：整体诉讼统计信息，包括裁判文书、开庭公告、执行公告、失信公告、法院公告、立案信息、限制高消费、终本案件

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.fygg` | Number | 是 | 法院公告信息数量 |  |
| `data.shixin` | Number | 是 | 失信公告信息数量 |  |
| `data.ktgg` | Number | 是 | 开庭公告信息数量 |  |
| `data.consumerResult` | Number | 是 | 限制高消费数量 |  |
| `data.total` | Number | 是 | 所有信息数量 |  |
| `data.cpws` | Number | 是 | 裁判文书信息数量 |  |
| `data.terminationCaseResult` | Number | 是 | 终本案件数量 |  |
| `data.lian` | Number | 是 | 立案信息数量 |  |
| `data.zxgg` | Number | 是 | 执行公告信息数量 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 6.4 涉诉统计信息

- Hub：`POST /api/v1/data/enterprise/6.4/query`；上游方法 GET；可调用
- 说明：企业涉诉统计信息，包括判决身份统计信息、涉案金额信息等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 公司全名、注册号、统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.pjsf_list` | Array | 是 | 判决身份信息 |  |
| `data.pjsf_list[].name` | String | 是 | 身份类型（原告，被告，上诉人，被上诉人，被执行人，申请人，被申请人，其他） |  |
| `data.pjsf_list[].value` | String | 是 | 统计数量 |  |
| `data.saje_list` | Array | 是 | 涉案金额信息 |  |
| `data.saje_list[].year` | Number | 是 | 年份（2018） |  |
| `data.saje_list[].negative` | Number | 是 | 负面涉案金额（单位： 元） |  |
| `data.saje_list[].other` | Number | 是 | 其他涉案金额（单位： 元） |  |
| `data.saje_list[].negative_freeze` | Number | 是 | 负面冻结金额（单位： 元） |  |
| `data.saje_list[].other_freeze` | Number | 是 | 其他冻结金额（单位： 元） |  |

### 85.71 案件串联

- Hub：`POST /api/v1/data/enterprise/85.71/query`；上游方法 GET（可选 GET/POST）；可调用
- 说明：根据企业名称，返回与企业相关的司法案件，案由，案号等信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 否分页跳过的记录数（默认为0）分页20 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].eid` | String | 是 | 企业eid |  |
| `data.items[].case_id` | String | 是 | 司法案件id |  |
| `data.items[].case_name` | String | 是 | 案件标题 |  |
| `data.items[].role_min_date` | String | 是 | 最早角色 |  |
| `data.items[].case_no` | String | 是 | 案号 |  |
| `data.items[].case_cause_min_date` | String | 是 | 案由 |  |
| `data.items[].case_type` | String | 是 | 案件类型 |  |
| `data.items[].case_min_date` | String | 是 | 案件最早时间 |  |
| `data.items[].newest_base_type` | String | 是 | 最新节点 |  |
| `data.items[].u_tags` | String | 是 | 0正常；1历史 |  |
| `data.items[].court` | String | 是 | 法院 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 18.39 案件流程节点

- Hub：`POST /api/v1/data/enterprise/18.39/query`；上游方法 GET；可调用
- 说明：通过司法案件id，查询审判流程，和审判节点信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `case_id` | String | 是 | 司法案件id |
| `skip` | Number | 否 | 分页跳过的记录数（默认为0）分页20 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].case_id` | String | 是 | 司法案件id |  |
| `data.items[].procedure_code` | String | 是 | 审判流程码值 |  |
| `data.items[].procedure_name` | String | 是 | 审判流程中文名 |  |
| `data.items[].procedure_date` | String | 是 | 审判流程日期 |  |
| `data.items[].period_type` | String | 是 | 案件阶段 |  |
| `data.items[].case_no` | String | 是 | 案号 |  |
| `data.items[].case_cause` | String | 是 | 案由 |  |
| `data.items[].court` | String | 是 | 法院 |  |
| `data.items[].detail_items` | Object | 是 | 节点信息 |  |
| `data.items[].detail_items.procedure_id` | String | 是 | 审判流程id |  |
| `data.items[].detail_items.data_type` | String | 是 | 节点名称 |  |
| `data.items[].detail_items.date` | String | 是 | 节点日期 |  |
| `data.items[].detail_items.detail` | String | 是 | 节点详情 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 27.59 企业风险统计

- Hub：`POST /api/v1/data/enterprise/27.59/query`；上游方法 GET；可调用
- 说明：企业自身风险、关联风险、司法风险、经营风险数值统计

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.ename` | String | 是 | 企业名称 |  |
| `data.risk` | Number | 是 | 自身风险 |  |
| `data.related_risk` | Number | 是 | 关联风险 |  |
| `data.judicial_risk` | Number | 是 | 司法风险 |  |
| `data.manage_risk` | Number | 是 | 经营风险 |  |

### 39.38 受贿违法

- Hub：`POST /api/v1/data/enterprise/39.38/query`；上游方法 GET；可调用
- 说明：企业受贿违法类裁判文书，包括判决基本信息及链接等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 分页跳过的记录数（默认为0）分页20 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].date` | String | 是 | 判决时间 |  |
| `data.items[].related_companies` | Array | 是 | 关联方 |  |
| `data.items[].related_companies[].item` | String | 是 | id |  |
| `data.items[].related_companies[].trial_result` | String | 是 | 审讯结果 |  |
| `data.items[].related_companies[].name` | String | 是 | 名称 |  |
| `data.items[].related_companies[].role` | String | 是 | 角色 |  |
| `data.items[].related_companies[].clean_role` | String | 是 | 角色归类 |  |
| `data.items[].related_companies[].by` | String | 是 | 通过方式 |  |
| `data.items[].related_companies[].type` | String | 是 | 对象类型：E企业；P个人 |  |
| `data.items[].pub_date` | String | 是 | 发布日期 |  |
| `data.items[].title` | String | 是 | 标题 |  |
| `data.items[].case_cause` | String | 是 | 案由 |  |
| `data.items[].sub_amount` | String | 是 | 判决金额​ |  |
| `data.items[].disabled` | String | 是 | 0：当前公示信息；1：历史公示信息 |  |
| `data.items[].court` | String | 是 | 法院 |  |
| `data.items[].judgeresult` | String | 是 | 判决结果 |  |
| `data.items[].url` | String | 是 | 链接 | 🔗 |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 99.68 董监高被执行

- Hub：`POST /api/v1/data/enterprise/99.68/query`；上游方法 GET；可调用
- 说明：企业董监高被执行数据

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `p_name` | String | 是 | 董监高法姓名 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].pname` | String | 是 | 人员姓名 |  |
| `data.items[].pid` | String | 是 | 人员ID |  |
| `data.items[].sex` | String | 是 | 性别；未知：-1，男：1，女：0 |  |
| `data.items[].case_no` | String | 是 | 案号 |  |
| `data.items[].start_date` | String | 是 | 立案时间 |  |
| `data.items[].court` | String | 是 | 执行法院 |  |
| `data.items[].amount` | String | 是 | 执行标的 |  |
| `data.items[].is_history` | String | 是 | 是否历史,；0否1是 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 16.53 董监高失信被执行

- Hub：`POST /api/v1/data/enterprise/16.53/query`；上游方法 GET；可调用
- 说明：企业董监高失信被执行数据

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `p_name` | String | 是 | 董监高法姓名 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].pname` | String | 是 | 人员姓名 |  |
| `data.items[].pid` | String | 是 | 人员ID |  |
| `data.items[].sex` | String | 是 | 性别；未知：-1，男：1，女：0 |  |
| `data.items[].case_no` | String | 是 | 案号 |  |
| `data.items[].start_date` | String | 是 | 立案时间 |  |
| `data.items[].court` | String | 是 | 执行法院 |  |
| `data.items[].doc_number` | String | 是 | 执行依据文号 |  |
| `data.items[].ex_department` | String | 是 | 做出执行依据单位 |  |
| `data.items[].final_duty` | String | 是 | 生效法律文书确定的义务 |  |
| `data.items[].execution_status` | String | 是 | 被执行人的履行情况 |  |
| `data.items[].execution_desc` | String | 是 | 失信被执行人行为具体情形 |  |
| `data.items[].performed_part` | String | 是 | 执行部分 |  |
| `data.items[].unperform_part` | String | 是 | 未执行部分 |  |
| `data.items[].is_history` | String | 是 | 是否历史,；0否1是 |  |

## 经营风险


### 32.1 行政处罚

- Hub：`POST /api/v1/data/enterprise/32.1/query`；上游方法 GET；可调用
- 说明：企业行政处罚信息，包括处罚类型、内容、时间及决定机关等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 工商行政处罚列表 |  |
| `data.items[].illegal_type` | String | 是 | 违法行为类型 |  |
| `data.items[].source` | string | 是 | 来源，工商，信用中国，金融，其他 |  |
| `data.items[].content` | String | 是 | 行政处罚内容 |  |
| `data.items[].department` | String | 是 | 决定机关名称 |  |
| `data.items[].publish_date` | String | 是 | 公示日期 |  |
| `data.items[].date` | String | 是 | 处罚决定日期 |  |
| `data.items[].description` | String | 是 | 详情 |  |
| `data.items[].disabled` | String | 是 | 0：当前公示信息；1：历史公示信息 |  |
| `data.items[].number` | String | 是 | 决定书文号 |  |
| `data.items[].based_on` | String | 是 | 处罚依据 |  |
| `data.items[].seq_no` | Number | 是 | 序号 |  |
| `data.items[].oper_name` | String | 是 | 法定代表人 |  |
| `data.items[].punish_amnt` | String | 是 | 罚款金额（万元） |  |
| `data.items[].status` | String | 是 | 状态 |  |
| `data.items[].push_type_one` | String | 是 | 处罚类别1 |  |
| `data.items[].push_type_two` | String | 是 | 处罚类别2 |  |
| `data.items[].reason` | String | 是 | 处罚事由 |  |
| `data.items[].illegal_income_amnt` | String | 是 | 没收违法所得和非法财物（万元） |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 67.1 终本案件

- Hub：`POST /api/v1/data/enterprise/67.1/query`；上游方法 GET；可调用
- 说明：企业终本案件信息，包括执行案号、终本日期、执行标的、未履行金额等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录,如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 终本案件信息列表 |  |
| `data.items[].terminateDate` | String | 是 | 终本日期 |  |
| `data.items[].amount` | String | 是 | 执行标的 |  |
| `data.items[].name` | String | 是 | 企业名称 |  |
| `data.items[].court` | String | 是 | 执行法院 |  |
| `data.items[].cardNum` | String | 是 | 组织机构号 |  |
| `data.items[].caseNoOrigin` | String | 是 | 执行依据案号 |  |
| `data.items[].caseNoTerminal` | String | 是 | 执行案号 |  |
| `data.items[].filingDate` | String | 是 | 立案日期 |  |
| `data.items[].failPerformAmount` | String | 是 | 未履行金额 |  |
| `data.items[].status` | Number | 是 | 0：未知；1：已履行；2：未履行；3：部分未履行 |  |
| `data.items[].address` | String | 是 | 地址 |  |
| `data.items[].is_history` | Number | 是 | 是否历史，0：否；1：是 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 25.1 动产抵押

- Hub：`POST /api/v1/data/enterprise/25.1/query`；上游方法 GET；可调用
- 说明：包括被担保债券数额种类、抵押物相关描述等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 动产抵押信息列表 |  |
| `data.items[].debit_currency` | String | 是 | 被担保债权数额币种 |  |
| `data.items[].debit_remarks` | String | 是 | 被担保债权概况-备注 |  |
| `data.items[].mortgagees` | Array | 是 | 抵押权人信息 |  |
| `data.items[].mortgagees[].seq_no` | Number | 是 | 抵押权人序号 |  |
| `data.items[].mortgagees[].name` | String | 是 | 抵押权人名称 |  |
| `data.items[].mortgagees[].identify_type` | String | 是 | 抵押权人类型 |  |
| `data.items[].mortgagees[].identify_no` | String | 是 | 抵押权企业证照号 |  |
| `data.items[].currency` | String | 是 | 抵押金额单位 |  |
| `data.items[].amount_new` | String | 是 | 抵押金额 |  |
| `data.items[].amount` | String | 是 | 被担保债权数额 |  |
| `data.items[].guarantees` | Array | 是 | 抵押物信息 |  |
| `data.items[].guarantees[].seq_no` | Number | 是 | 抵押物序号 |  |
| `data.items[].guarantees[].name` | String | 是 | 抵押物名称 |  |
| `data.items[].guarantees[].belong_to` | String | 是 | 抵押物所有权归属 |  |
| `data.items[].guarantees[].desc` | String | 是 | 抵押物描述 |  |
| `data.items[].guarantees[].remarks` | String | 是 | 抵押物备注 |  |
| `data.items[].status` | String | 是 | 状态 |  |
| `data.items[].department` | String | 是 | 登记机关 |  |
| `data.items[].seq_no` | Number | 是 | 序号 |  |
| `data.items[].disabled` | String | 是 | 0：当前公示信息；1：历史公示信息 |  |
| `data.items[].number` | String | 是 | 登记编号 |  |
| `data.items[].remarks` | String | 是 | 备注 |  |
| `data.items[].date` | String | 是 | 登记日期 |  |
| `data.items[].scope` | String | 是 | 担保范围 |  |
| `data.items[].period_end` | String | 是 | 抵押结束时间 |  |
| `data.items[].period_start` | String | 是 | 抵押起始时间 |  |
| `data.items[].period` | String | 是 | 债务人履行债务的期限 |  |
| `data.items[].type` | String | 是 | 被担保债权种类 |  |
| `data.items[].close_reason` | String | 是 | 注销原因 |  |
| `data.items[].debit_type` | String | 是 | 被担保债权概况-种类 |  |
| `data.items[].debit_period` | String | 是 | 被担保债权概况-债务人履行债务的期限 |  |
| `data.items[].close_date` | String | 是 | 注销日期 |  |
| `data.items[].debit_amount` | String | 是 | 被担保债权概况-数额 |  |
| `data.items[].debit_scope` | String | 是 | 被担保债权概况-担保的范围 |  |
| `data.items[].changeInfo` | Array | 是 | 变更信息 |  |
| `data.items[].changeInfo[].seq_no` | String | 是 | 序号 |  |
| `data.items[].changeInfo[].content` | String | 是 | 变更内容 |  |
| `data.items[].changeInfo[].change_date` | String | 是 | 变更时间 |  |
| `data.items[].public_date` | String | 是 | 公示日期 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 26.1 股权出质

- Hub：`POST /api/v1/data/enterprise/26.1/query`；上游方法 GET；可调用
- 说明：企业股权出质信息，包括出质人、出质股权、质权人等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 股权出质信息列表 |  |
| `data.items[].pawnee` | String | 是 | 质权人 |  |
| `data.items[].remark` | String | 是 | 备注 |  |
| `data.items[].status` | String | 是 | 状态 |  |
| `data.items[].disabled` | String | 是 | 0：当前公示信息；1：历史公示信息 |  |
| `data.items[].number` | String | 是 | 登记编号 |  |
| `data.items[].pledgor_identify_type` | String | 是 | 出质人类型 |  |
| `data.items[].pledgor_identify_no` | String | 是 | 出质企业证照号 |  |
| `data.items[].date` | String | 是 | 股权出质登记日期 |  |
| `data.items[].pledgor` | String | 是 | 出质人 |  |
| `data.items[].pledgor_amount` | String | 是 | 出质股权数 |  |
| `data.items[].seq_no` | Number | 是 | 序号 |  |
| `data.items[].pledgor_currency` | String | 是 | 出质股权数额币种 |  |
| `data.items[].pledgor_unit` | String | 是 | 出质股权数额单位 |  |
| `data.items[].pawnee_identify_no` | String | 是 | 质权企业证照号 |  |
| `data.items[].object_company` | String | 是 | 标的方 |  |
| `data.items[].change_items` | Array | 是 | 变更记录 |  |
| `data.items[].change_items[].seq_no` | String | 是 | 变更记录序号 |  |
| `data.items[].change_items[].change_date` | String | 是 | 变更日期 |  |
| `data.items[].change_items[].change_content` | String | 是 | 变更内容 |  |
| `data.items[].pawnee_identify_type` | String | 是 | 质权人类型 |  |
| `data.items[].cancel_date` | String | 是 | 注销日期 |  |
| `data.items[].cancel_content` | String | 是 | 注销原因 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 34.1 股权冻结

- Hub：`POST /api/v1/data/enterprise/34.1/query`；上游方法 GET；可调用
- 说明：企业股权冻结信息，包括被执行人相关信息以及冻结金额、原因等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中疑似关系总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 股权冻结信息列表 |  |
| `data.items[].pc_freeze_detail` | Object | 是 | 执行详细信息 |  |
| `data.items[].pc_freeze_detail.xz_execute_date` | String | 是 | 协助执行日期 |  |
| `data.items[].pc_freeze_detail.notice_no` | String | 是 | 执行通知书文号 |  |
| `data.items[].pc_freeze_detail.assist_item` | String | 是 | 执行事项 |  |
| `data.items[].pc_freeze_detail.assignee_ident_type` | String | 是 | 受让人证件类型 |  |
| `data.items[].pc_freeze_detail.assist_ident_type` | String | 是 | 被执行人证件种类 |  |
| `data.items[].pc_freeze_detail.freeze_ amount` | String | 是 | 被执行人持有股权、其它投资权益的数额 |  |
| `data.items[].pc_freeze_detail.assignee_ident_no` | String | 是 | 受让企业证照号 |  |
| `data.items[].pc_freeze_detail.assignee` | String | 是 | 受让人 |  |
| `data.items[].pc_freeze_detail.assist_name` | String | 是 | 被执行人 |  |
| `data.items[].pc_freeze_detail.assist_ident_no` | String | 是 | 被执行企业证照号 |  |
| `data.items[].pc_freeze_detail.execute_court` | String | 是 | 执行法院 |  |
| `data.items[].pc_freeze_detail.adjudicate_no` | String | 是 | 执行裁定书文号 |  |
| `data.items[].pc_freeze_detail.eid` | String | 是 | 被执行企业 ID |  |
| `data.items[].pc_freeze_detail.aid` | String | 是 | 受让企业 ID |  |
| `data.items[].status` | String | 是 | 状态 |  |
| `data.items[].lose_efficacy` | Object | 是 | 失效信息 |  |
| `data.items[].lose_efficacy.reason` | String | 是 | 失效原因 |  |
| `data.items[].lose_efficacy.date` | String | 是 | 失效时间 |  |
| `data.items[].executive_court` | String | 是 | 执行法院 |  |
| `data.items[].seq_no` | Number | 是 | 序号 |  |
| `data.items[].amount` | String | 是 | 股权数额 |  |
| `data.items[].detail` | Object | 是 | 冻结详细信息 |  |
| `data.items[].detail.corp_name` | String | 是 | 企业名称 |  |
| `data.items[].detail.notice_no` | String | 是 | 执行通知书文号 |  |
| `data.items[].detail.assist_item` | String | 是 | 执行事项 |  |
| `data.items[].detail.public_date` | String | 是 | 公示日期 |  |
| `data.items[].detail.assist_ident_type` | String | 是 | 被执行人类型 |  |
| `data.items[].detail.freeze_start_date` | String | 是 | 冻结期限自 |  |
| `data.items[].detail.freeze_amount` | String | 是 | 被执行人持有股权、其它投资权益的数额 |  |
| `data.items[].detail.freeze_year_month` | String | 是 | 冻结期限 |  |
| `data.items[].detail.assist_name` | String | 是 | 被执行人 |  |
| `data.items[].detail.assist_ident_no` | String | 是 | 被执行企业证照号 |  |
| `data.items[].detail.freeze_end_date` | String | 是 | 冻结期限至 |  |
| `data.items[].detail.execute_court` | String | 是 | 执行法院 |  |
| `data.items[].detail.adjudicate_no` | String | 是 | 执行裁定书文号 |  |
| `data.items[].detail.eid` | String | 是 | 被执行企业 ID |  |
| `data.items[].type` | String | 是 | 类型 |  |
| `data.items[].disabled` | String | 是 | 0：当前公示信息；1：历史公示信息 |  |
| `data.items[].be_executed_person` | String | 是 | 被执行人 |  |
| `data.items[].continue_freeze_details` | Array | 是 | 续行冻结详细信息 |  |
| `data.items[].continue_freeze_details[].execute_court` | String | 是 | 执行法院 |  |
| `data.items[].continue_freeze_details[].assist_item` | String | 是 | 执行事项 |  |
| `data.items[].continue_freeze_details[].adjudicate_no` | String | 是 | 执行裁定书文号 |  |
| `data.items[].continue_freeze_details[].notice_no` | String | 是 | 执行通知书文号 |  |
| `data.items[].continue_freeze_details[].assist_name` | String | 是 | 被执行人 |  |
| `data.items[].continue_freeze_details[].freeze_amount` | String | 是 | 被执行人持有股权、其它投资权益的数额 |  |
| `data.items[].continue_freeze_details[].assist_ident_type` | String | 是 | 被执行人类型 |  |
| `data.items[].continue_freeze_details[].assist_ident_no` | String | 是 | 被执行企业证照号 |  |
| `data.items[].continue_freeze_details[].continue_date_start` | String | 是 | 续行冻结期限自 |  |
| `data.items[].continue_freeze_details[].continue_date_end` | String | 是 | 续行冻结期限至 |  |
| `data.items[].continue_freeze_details[].continue_date_peroid` | String | 是 | 续行冻结期周期 |  |
| `data.items[].continue_freeze_details[].public_date` | String | 是 | 公示日期 |  |
| `data.items[].continue_freeze_details[].eid` | String | 是 | 被执行企业 ID |  |
| `data.items[].number` | String | 是 | 执行通知书文号 |  |
| `data.items[].un_freeze_details` | Array | 是 | 解冻详细信息 |  |
| `data.items[].un_freeze_details[].corp_ name` | String | 是 | 企业名称 |  |
| `data.items[].un_freeze_details[].notice_no` | String | 是 | 执行通知书文号 |  |
| `data.items[].un_freeze_details[].assist_item` | String | 是 | 执行事项 |  |
| `data.items[].un_freeze_details[].public_date` | String | 是 | 公示日期 |  |
| `data.items[].un_freeze_details[].assist_ident_type` | String | 是 | 被执行人类型 |  |
| `data.items[].un_freeze_details[].unfreeze_date` | String | 是 | 解冻日期 |  |
| `data.items[].un_freeze_details[].freeze_amount` | String | 是 | 被执行人持有股权、其它投资权益的数额 |  |
| `data.items[].un_freeze_details[].assist_name` | String | 是 | 被执行人 |  |
| `data.items[].un_freeze_details[].assist_ident_no` | String | 是 | 被执行企业证照号 |  |
| `data.items[].un_freeze_details[].execute_court` | String | 是 | 执行法院 |  |
| `data.items[].un_freeze_details[].adjudicate_no` | String | 是 | 执行裁定书文号 |  |
| `data.items[].un_freeze_details[].eid` | String | 是 | 被执行企业 ID |  |
| `data.items[].eid` | String | 是 | 被执行企业 ID |  |
| `data.items[].obj_name` | String | 是 | 标的方企业 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 1.55 经营异常

- Hub：`POST /api/v1/data/enterprise/1.55/query`；上游方法 GET；可调用
- 说明：企业经营异常信息，企业被列入或移出的原因和时间，以及做出决定的机关等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 企业经营异常信息列表 |  |
| `data.items[].province` | String | 是 | 省份 |  |
| `data.items[].inDate` | String | 是 | 列入时间 |  |
| `data.items[].department` | String | 是 | 做出决定机关 |  |
| `data.items[].outDate` | String | 是 | 移出时间 |  |
| `data.items[].outReason` | String | 是 | 移出原因 |  |
| `data.items[].regNo` | String | 是 | 注册号 |  |
| `data.items[].disabled` | String | 是 | 是否历史：0：否，当前公示信息；1：是，历史公示信息 |  |
| `data.items[].inReason` | String | 是 | 列入原因 |  |
| `data.items[].name` | String | 是 | 企业名称 |  |
| `data.items[].out_department` | String | 是 | 移出异常做出决定机关 |  |
| `data.items[].is_cancel` | String | 是 | 是否下架，0否1是 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 56.1 严重违法

- Hub：`POST /api/v1/data/enterprise/56.1/query`；上游方法 GET；可调用
- 说明：企业工商严重违法信息，企业被列入或移出的原因和时间，以及做出决定的机关等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回 为空。具体字段含义见下表 |  |
| `data.executed_person` | Array | 是 | 失信被执行人信息（该字段数据源已废弃） |  |
| `data.tax_violation` | Array | 是 | 重大税收违法案件信息（该字段数据源已废弃） |  |
| `data.execution` | Array | 是 | 严重违法失信企业名单（黑名单）信息, 数组列表，详细字段如下: |  |
| `data.execution[].in_reason` | String | 是 | 列入严重违法失信企业名单（黑名单）原 因 |  |
| `data.execution[].in_date` | String | 是 | 列入日期 |  |
| `data.execution[].in_department` | String | 是 | 作出决定机关（列入） |  |
| `data.execution[].out_date` | String | 是 | 移出时间 |  |
| `data.execution[].out_reason` | String | 是 | 移出严重违法失信企业名单（黑名单）原 因 |  |
| `data.execution[].out_department` | String | 是 | 作出决定机关（移出） |  |
| `data.execution[].is_history` | Number | 是 | 0，非历史信息；1 历史信息 |  |

### 20.1 欠税信息

- Hub：`POST /api/v1/data/enterprise/20.1/query`；上游方法 GET；可调用
- 说明：企业欠税信息，包括纳税人类型、纳税人识别号、欠税税种、余额等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前10条，取11到20条的数据，skip=10，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 欠税信息列表 |  |
| `data.items[].overdue_period` | String | 是 | 欠税所属期 |  |
| `data.items[].is_history` | String | 是 | 是否历史信息(0:否,1:是) |  |
| `data.items[].pub_department` | String | 是 | 发布单位 |  |
| `data.items[].taxpayer_type` | String | 是 | 纳税人类型 |  |
| `data.items[].pub_date` | String | 是 | 发布日期 |  |
| `data.items[].area` | String | 是 | 所属市县区 |  |
| `data.items[].address` | String | 是 | 经营地点 |  |
| `data.items[].oper_name` | String | 是 | 负责人姓名 |  |
| `data.items[].taxpayer_num` | String | 是 | 纳税人识别号 |  |
| `data.items[].overdue_amount` | Number | 是 | 欠税余额 |  |
| `data.items[].overdue_time` | String | 是 | 发生欠税的时间 |  |
| `data.items[].overdue_type` | String | 是 | 欠税税种 |  |
| `data.items[].oper_id_num` | String | 是 | 企业证照号 |  |
| `data.items[].curr_overdue_amount` | Number | 是 | 当前发生的欠税余额，单位：元 |  |
| `data.items[].overdue_penalty` | Number | 是 | 已缴纳欠税对应形成的欠缴税款滞纳金金额 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 20.11 欠税合计

- Hub：`POST /api/v1/data/enterprise/20.11/query`；上游方法 GET；可调用
- 说明：根据企业全名/注册号/统一社会信用代码获得企业欠税合计金额。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.overdue_total` | Number | 是 | 各期欠税金额合计（单位：元） |  |
| `sign` | string | 是 | 数据签名 |  |
| `status` | string | 是 | 接口调用状态 |  |
| `message` | string | 是 | 返回结果消息 |  |

### 63.2 非正常户

- Hub：`POST /api/v1/data/enterprise/63.2/query`；上游方法 GET；可调用
- 说明：企业非正常户信息，包括纳税人识别号、认定原因、欠税种类及金额等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名、统代、注册号 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 非正常信息 |  |
| `data.items[].name` | String | 是 | 企业名称 |  |
| `data.items[].reason` | String | 是 | 认定原因 |  |
| `data.items[].state` | String | 是 | 纳税人状态 |  |
| `data.items[].judge_date` | String | 是 | 认定日期 |  |
| `data.items[].judge_department` | String | 是 | 认定单位 |  |
| `data.items[].area` | String | 是 | 生产经营地址 |  |
| `data.items[].overdue_amount` | String | 是 | 欠税金额 |  |
| `data.items[].eid` | String | 是 | 企业id |  |
| `data.items[].tax_num` | String | 是 | 纳税人识别号 |  |
| `data.items[].judge_area` | String | 是 | 认定单位的地址 |  |
| `data.items[].pub_date` | String | 是 | 公告日期 |  |
| `data.items[].judge_phone` | String | 是 | 认定单位电话 |  |
| `data.items[].is_history` | String | 是 | 是否历史，0非历史，1历史 |  |
| `data.items[].overdue_type` | String | 是 | 欠税税务种类 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 20.3 重大税收违法

- Hub：`POST /api/v1/data/enterprise/20.3/query`；上游方法 GET；可调用
- 说明：企业重大税收违法信息，包括案件性质、主要违法事实等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 重大税收违法案件列表 |  |
| `data.items[].u_tags` | Number | 是 | 0正常；1历史 |  |
| `data.items[].property` | String | 是 | 案件性质 |  |
| `data.items[].created_time` | String | 是 | 创建时间 |  |
| `data.items[].finance_officer` | String | 是 | 负有直接责任的财务负责人 |  |
| `data.items[].name` | String | 是 | 纳税人名称 |  |
| `data.items[].credit_no` | String | 是 | 纳税人识别号 |  |
| `data.items[].oper` | String | 是 | 法定代表人或者负责人 |  |
| `data.items[].time` | String | 是 | 发生时间 |  |
| `data.items[].address` | String | 是 | 注册地址 |  |
| `data.items[].result` | String | 是 | 相关法律依据及,税务处理处罚情况 |  |
| `data.items[].org_no` | String | 是 | 组织机构代码 |  |
| `data.items[].url` | String | 是 | 原文链接 | 🔗 |
| `data.items[].agent` | String | 是 | 负有直接责任的中介机构信息及其从业人员 |  |
| `data.items[].illegal_fact` | String | 是 | 主要违法事实 |  |
| `data.items[].updated_time` | String | 是 | 更新时间 |  |
| `data.items[].check_department` | String | 是 | 检查机关 |  |
| `data.items[].type` | String | 是 | 公示税务机关 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 79.17 产品投诉情况

- Hub：`POST /api/v1/data/enterprise/79.17/query`；上游方法 GET；可调用
- 说明：根据企业全名/注册号/统一社会信用代码获得投诉对象、问题、详情、进度、涉及金额等信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `start_date` | String | 否 | 查询起始时间，格式为 YYYYMMDD（默认为 end_date 减 1 个月） |
| `end_date` | String | 否 | 查询截止时间，格式为 YYYYMMDD（默认为当 前日期） |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].short_name` | String | 是 | 企业/产品简称 |  |
| `data.items[].type` | Number | 是 | 企业类型（1：投诉企业，2：相关企业） |  |
| `data.items[].pub_time` | String | 是 | 发布日期 |  |
| `data.items[].title` | String | 是 | 标题 |  |
| `data.items[].complaint_obj` | String | 是 | 投诉对象 |  |
| `data.items[].problem` | String | 是 | 投诉问题 |  |
| `data.items[].appeal` | String | 是 | 投诉要求 |  |
| `data.items[].amount` | String | 是 | 涉及金额 |  |
| `data.items[].detail` | String | 是 | 投诉详情 |  |
| `data.items[].schedule` | String | 是 | 投诉进度 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 1.35 工商清算组人员

- Hub：`POST /api/v1/data/enterprise/1.35/query`；上游方法 GET；可调用
- 说明：企业工商清算组信息，包括清算组负责人及成员信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.u_tags` | String | 是 | 是否历史，0：正常数据；1：历史数据 |  |
| `data.leader` | String | 是 | 清算组负责人 |  |
| `data.employees` | Array | 是 | 清算组成员（数组） |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 22.8 企业工程不良行为

- Hub：`POST /api/v1/data/enterprise/22.8/query`；上游方法 GET；可调用
- 说明：企业工程不良行为，包括诚信记录主体、文号、决定日期、发布有效期等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 工程不良信息列表 |  |
| `data.items[].reason` | String | 是 | 事由 |  |
| `data.items[].validity_start` | String | 是 | 决定日期 |  |
| `data.items[].issue_org` | String | 是 | 实施部门 |  |
| `data.items[].content` | String | 是 | 决定内容 |  |
| `data.items[].name` | String | 是 | 诚信记录主体 |  |
| `data.items[].category` | String | 是 | 类型 |  |
| `data.items[].no` | String | 是 | 诚信记录编号 |  |
| `data.items[].issue_no` | String | 是 | 文号 |  |
| `data.items[].url` | String | 是 | 原文链接 | 🔗 |
| `data.items[].updated_time` | String | 是 | 更新时间 |  |
| `data.items[].created_time` | String | 是 | 创建时间 |  |
| `data.items[].validity_end` | String | 是 | 发布有效期 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 12.5 知识产权出质

- Hub：`POST /api/v1/data/enterprise/12.5/query`；上游方法 GET；可调用
- 说明：知识产权出质信息，包括出质种类、出质人名称、质权人名称、登记期限等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/统一社会信用代码 |
| `skip` | Number | 否 | 分页参数 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 知识产权出质列表 |  |
| `data.items[].pawnee` | String | 是 | 质权人名称 |  |
| `data.items[].period` | String | 是 | 质权登记期限 |  |
| `data.items[].pawnee_type` | String | 是 | 质权人类型（质权人为公司）：0 企业，4社团，5律所，6香港公司 |  |
| `data.items[].pledgor_eid` | String | 是 | 出质企业id（出质人为公司） |  |
| `data.items[].status` | String | 是 | 状态 |  |
| `data.items[].public_date` | String | 是 | 公示日期 |  |
| `data.items[].name` | String | 是 | 知识产权名称 |  |
| `data.items[].eid` | String | 是 | 企业id |  |
| `data.items[].pledgor_type` | String | 是 | 出质人类型：0 企业，4社团，5律所，6香港公司 |  |
| `data.items[].pledgor` | String | 是 | 出质人名称 |  |
| `data.items[].pawnee_eid` | String | 是 | 质权企业id |  |
| `data.items[].number` | String | 是 | 注册号 |  |
| `data.items[].type` | String | 是 | 种类 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 51.1 环保处罚列表

- Hub：`POST /api/v1/data/enterprise/51.1/query`；上游方法 GET；可调用
- 说明：企业环保处罚列表，包括处罚类型、日期等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 企业环保处罚信息列表 |  |
| `data.items[].document_no` | String | 是 | 文书号 |  |
| `data.items[].punishment_date` | String | 是 | 处罚日期/处罚生效期 |  |
| `data.items[].punishment_dept` | String | 是 | 作出处罚单位名称 |  |
| `data.items[].disabled` | String | 是 | 0：当前公示信息；1：历史公示信息 |  |
| `data.items[].id` | String | 是 | 环保处罚id |  |
| `data.items[].punish_amnt` | String | 是 | 处罚金额（万元） |  |
| `data.items[].punishment_type` | String | 是 | 环保处罚类型 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 51.3 环保处罚详情

- Hub：`POST /api/v1/data/enterprise/51.3/query`；上游方法 GET；可调用
- 说明：企业环保处罚详情，包括处罚类型、处罚生效/废止时间、处罚详情链接等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | String | 是 | 环保处罚id |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.disabled` | String | 是 | 0：当前公示信息；1：历史公示信息 |  |
| `data.punishments` | Object | 是 | 处罚信息列表 |  |
| `data.punishments.illegal_type` | String | 是 | 违法类型/类别 |  |
| `data.punishments.punishment_title` | String | 是 | 处罚名称 |  |
| `data.punishments.punishment_date` | String | 是 | 处罚日期/处罚生效期 |  |
| `data.punishments.end_date` | String | 是 | 废止日期/处罚截止期 |  |
| `data.punishments.document_url` | String | 是 | 文书 | 🔗 |
| `data.punishments.document_no` | String | 是 | 文书号 |  |
| `data.punishments.implement_status` | String | 是 | 执行情况 |  |
| `data.punishments.punishment_reason` | String | 是 | 处罚事由/违法事实(浙) |  |
| `data.punishments.punishment_basis` | String | 是 | 处罚依据 |  |
| `data.punishments.punishment_measure` | String | 是 | 处罚措施 |  |
| `data.punishments.punishment_content` | String | 是 | 处罚内容 |  |
| `data.punishments.punishment_dept` | String | 是 | 作出处罚单位名称 |  |
| `data.punishments.punishment_result` | String | 是 | 处罚结果 |  |
| `data.punishments.punishment_type` | String | 是 | 处罚类别 |  |
| `data.punishments.update_date` | String | 是 | 数据更新时间 |  |
| `data.punishments.now_status` | String | 是 | 当前状态 |  |
| `data.punishments.remarks` | String | 是 | 备注 |  |
| `data.province` | String | 是 | 省份名称 |  |
| `data.document_html` | String | 是 | 环境处罚决定书 |  |
| `data.name` | String | 是 | 企业全名 |  |
| `data.eid` | String | 是 | 企业id |  |
| `data.url` | String | 是 | 详细链接 | 🔗 |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 66.36 食品安全

- Hub：`POST /api/v1/data/enterprise/66.36/query`；上游方法 GET；可调用
- 说明：通过企业名称/统代/注册号查询食品安全抽检公布结果

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |
| `type` | String | 否 | 企业性质（0被抽检单位1生产企业），默认为0 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].food_name` | String | 是 | 食品名称 |  |
| `data.items[].checked_name` | String | 是 | 被抽检单位名称 |  |
| `data.items[].checked_company_province` | String | 是 | 被抽检单位所在省份 |  |
| `data.items[].ename` | String | 是 | 标称生产企业名称 |  |
| `data.items[].checked_company_address` | String | 是 | 标称生产企业地址 |  |
| `data.items[].production_date` | String | 是 | 生产日期/批号 |  |
| `data.items[].model` | String | 是 | 规格型号 |  |
| `data.items[].times_all` | String | 是 | 抽检总次数 |  |
| `data.items[].times_unqualified` | String | 是 | 不合格次数 |  |
| `data.items[].result_all` | String | 是 | 抽检结果统计 |  |
| `data.items[].result` | Number | 是 | 抽检结果：0：不合规；1：合格 |  |
| `data.items[].unqualified_detail` | String | 是 | 不合格详情{"item_name":"检测项目名称 ","num_standard":"标准值 ","num_detect":"检测值"} |  |
| `data.items[].url` | String | 是 | 链接 | 🔗 |
| `data.items[].is_history` | String | 是 | 历史标记；0-否，1-是 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 66.34 产品召回

- Hub：`POST /api/v1/data/enterprise/66.34/query`；上游方法 GET；可调用
- 说明：根据企业名称获取企业产品召回信息，包括召回产品名称、召回类型、详情等相关信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].ename` | String | 是 | 召回企业 |  |
| `data.items[].release_date` | String | 是 | 发布日期 |  |
| `data.items[].title` | String | 是 | 标题 |  |
| `data.items[].is_history` | Number | 是 | 是否历史。0-否，1-是 |  |
| `data.items[].product_name` | String | 是 | 召回产品名称 |  |
| `data.items[].recall_type` | String | 是 | 召回类型。01-汽车召回，02-消费品召回 |  |
| `data.items[].detail` | String | 是 | 详情 |  |
| `data.items[].url` | String | 是 | url | 🔗 |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 66.35 未准入境

- Hub：`POST /api/v1/data/enterprise/66.35/query`；上游方法 GET；可调用
- 说明：根据企业全名/注册号/统一社会信用代码获取未准入境信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 否 | 生产企业全名/注册号/统一社会信用代 码。生产企业与进口商必填其一，可以两 个都填 |
| `import_keyword` | String | 否 | 进口商全名/注册号/统一社会信用代码。 生产企业名称与进口商名称必填其一，可 以两个都填 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

keyword 与 import_keyword 至少提供一个。

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 未准入境信息列表 |  |
| `data.items[].ename` | String | 是 | 生产企业名称 |  |
| `data.items[].importer_name` | String | 是 | 进口商名称 |  |
| `data.items[].product_name` | String | 是 | 产品名称 |  |
| `data.items[].type` | Number | 是 | 产品类型。1-食品，2-化妆品，3-工业产 品 |  |
| `data.items[].brand` | String | 是 | 品牌 |  |
| `data.items[].quality` | String | 是 | 数量/重量 |  |
| `data.items[].reason` | String | 是 | 未准入境的原因/不合格原因 |  |
| `data.items[].measure` | String | 是 | 处置措施 |  |
| `data.items[].release_date` | String | 是 | 发布日期 |  |
| `data.items[].city` | String | 是 | 进境口岸 |  |
| `data.items[].record_no` | String | 是 | 进口商备案号 |  |
| `data.items[].HS` | String | 是 | HS编码 |  |
| `data.items[].test_number` | String | 是 | 检验检疫编号 |  |
| `data.items[].nation` | String | 是 | 产地 |  |
| `data.items[].origin_nation` | String | 是 | 原产地 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 66.56 违法违规建设

- Hub：`POST /api/v1/data/enterprise/66.56/query`；上游方法 GET（可选 GET/POST）；可调用
- 说明：根据企业名称获取企业违法违规建设情况，包括项目名称、生产状况、存在问题等相关信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].ename` | String | 是 | 企业名称 |  |
| `data.items[].province` | String | 是 | 所在省份 |  |
| `data.items[].city` | String | 是 | 所在城市 |  |
| `data.items[].district` | String | 是 | 所在地区 |  |
| `data.items[].entry_name` | String | 是 | 项目名称 |  |
| `data.items[].production_status` | String | 是 | 生产状况 |  |
| `data.items[].start_time` | String | 是 | 开工建设时间 |  |
| `data.items[].exist_question` | String | 是 | 存在问题 |  |
| `data.items[].clean_action` | String | 是 | 清理措施 |  |
| `data.items[].account_unit` | String | 是 | 责任单位 |  |
| `data.items[].execution` | Number | 是 | 是否完成(0否，1是，-1未知) |  |
| `data.items[].quasi_complete_time_limit` | String | 是 | 拟完成时限 |  |
| `data.items[].is_history` | Number | 是 | 是否历史（0否，1是） |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 40.2 司法协助

- Hub：`POST /api/v1/data/enterprise/40.2/query`；上游方法 GET；可调用
- 说明：企业司法协助信息，包括司法机构协助执行的相关信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |
| `type_code` | String | 否 | 默认全部，仅支持单个输入，类型：1股权变更，2股权冻结，3其他 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].number` | String | 是 | 协助公示通知书文号 |  |
| `data.items[].seq_no` | String | 是 | 序号 |  |
| `data.items[].status` | String | 是 | 状态 |  |
| `data.items[].type` | String | 是 | 类型 |  |
| `data.items[].type_code` | String | 是 | 类型编码，1股权变更，2股权冻结，-1其他 |  |
| `data.items[].amount` | String | 是 | 股权数额 |  |
| `data.items[].be_executed_person` | String | 是 | 被执行人 |  |
| `data.items[].eid` | String | 是 | 被执行企业ID |  |
| `data.items[].disabled` | String | 是 | 0：当前公示信息；1：历史公示信息 |  |
| `data.items[].executive_court` | String | 是 | 执行法院 |  |
| `data.items[].obj_name` | String | 是 | 标准名称 |  |
| `data.items[].lose_efficacy` | Object | 是 | 失效信息 |  |
| `data.items[].lose_efficacy.reason` | String | 是 | 失效原因 |  |
| `data.items[].lose_efficacy.date` | String | 是 | 失效时间 |  |
| `data.items[].detail` | Object | 是 | 冻结详细信息 |  |
| `data.items[].detail.corp_name` | String | 是 | 企业名称 |  |
| `data.items[].detail.notice_no` | String | 是 | 执行通知书文号 |  |
| `data.items[].detail.assist_item` | String | 是 | 执行事项 |  |
| `data.items[].detail.public_date` | String | 是 | 公示日期 |  |
| `data.items[].detail.assist_ident_type` | String | 是 | 被执行人类型 |  |
| `data.items[].detail.freeze_start_date` | String | 是 | 冻结期限自 |  |
| `data.items[].detail.freeze_amount` | String | 是 | 被执行人持有股权、其它投资权益的数额 |  |
| `data.items[].detail.freeze_year_month` | String | 是 | 冻结期限 |  |
| `data.items[].detail.assist_name` | String | 是 | 被执行人 |  |
| `data.items[].detail.assist_ident_no` | String | 是 | 被执行企业证照号 |  |
| `data.items[].detail.freeze_end_date` | String | 是 | 冻结期限至 |  |
| `data.items[].detail.execute_court` | String | 是 | 执行法院 |  |
| `data.items[].detail.adjudicate_no` | String | 是 | 执行裁定书文号 |  |
| `data.items[].detail.eid` | String | 是 | 被执行企业ID |  |
| `data.items[].un_freeze_details` | Array | 是 | 解冻详细信息 |  |
| `data.items[].un_freeze_details[].corp_name` | String | 是 | 企业名称 |  |
| `data.items[].un_freeze_details[].notice_no` | String | 是 | 执行通知书文号 |  |
| `data.items[].un_freeze_details[].assist_item` | String | 是 | 执行事项 |  |
| `data.items[].un_freeze_details[].public_date` | String | 是 | 公示日期 |  |
| `data.items[].un_freeze_details[].assist_ident_type` | String | 是 | 被执行人类型 |  |
| `data.items[].un_freeze_details[].unfreeze_date` | String | 是 | 解冻日期 |  |
| `data.items[].un_freeze_details[].freeze_amount` | String | 是 | 被执行人持有股权、其它投资权益的数额 |  |
| `data.items[].un_freeze_details[].assist_name` | String | 是 | 被执行人 |  |
| `data.items[].un_freeze_details[].assist_ident_no` | String | 是 | 被执行企业证照号 |  |
| `data.items[].un_freeze_details[].execute_court` | String | 是 | 执行法院 |  |
| `data.items[].un_freeze_details[].adjudicate_no` | String | 是 | 执行裁定书文号 |  |
| `data.items[].un_freeze_details[].eid` | String | 是 | 被执行企业ID |  |
| `data.items[].pc_freeze_detail` | Object | 是 | 执行详细信息 |  |
| `data.items[].pc_freeze_detail.xz_execute_date` | String | 是 | 协助执行日期 |  |
| `data.items[].pc_freeze_detail.notice_no` | String | 是 | 执行通知书文号 |  |
| `data.items[].pc_freeze_detail.assist_item` | String | 是 | 执行事项 |  |
| `data.items[].pc_freeze_detail.assignee_ident_type` | String | 是 | 受让人证件类型 |  |
| `data.items[].pc_freeze_detail.assist_ident_type` | String | 是 | 被执行人类型 |  |
| `data.items[].pc_freeze_detail.freeze_amount` | String | 是 | 被执行人持有股权、其它投资权益的数额 |  |
| `data.items[].pc_freeze_detail.assignee_ident_no` | String | 是 | 受让企业证照号 |  |
| `data.items[].pc_freeze_detail.assignee` | String | 是 | 受让人 |  |
| `data.items[].pc_freeze_detail.assist_name` | String | 是 | 被执行人 |  |
| `data.items[].pc_freeze_detail.assist_ident_no` | String | 是 | 被执行企业证照号 |  |
| `data.items[].pc_freeze_detail.execute_court` | String | 是 | 执行法院 |  |
| `data.items[].pc_freeze_detail.adjudicate_no` | String | 是 | 执行裁定书文号 |  |
| `data.items[].pc_freeze_detail.eid` | String | 是 | 被执行企业ID |  |
| `data.items[].pc_freeze_detail.aid` | String | 是 | 受让企业ID |  |
| `data.items[].continue_freeze_details` | Array | 是 | 续行冻结详细信息 |  |
| `data.items[].continue_freeze_details[].execute_court` | String | 是 | 执行法院 |  |
| `data.items[].continue_freeze_details[].assist_item` | String | 是 | 执行事项 |  |
| `data.items[].continue_freeze_details[].adjudicate_no` | String | 是 | 执行裁定书文号 |  |
| `data.items[].continue_freeze_details[].notice_no` | String | 是 | 执行通知书文号 |  |
| `data.items[].continue_freeze_details[].assist_name` | String | 是 | 被执行人 |  |
| `data.items[].continue_freeze_details[].freeze_amount` | String | 是 | 被执行人持有股权、其它投资权益的数额 |  |
| `data.items[].continue_freeze_details[].assist_ident_type` | String | 是 | 被执行人类型 |  |
| `data.items[].continue_freeze_details[].assist_ident_no` | String | 是 | 被执行企业证照号 |  |
| `data.items[].continue_freeze_details[].continue_date_start` | String | 是 | 续行冻结期限自 |  |
| `data.items[].continue_freeze_details[].continue_date_end` | String | 是 | 续行冻结期限至 |  |
| `data.items[].continue_freeze_details[].continue_date_peroid` | String | 是 | 续行冻结期限 |  |
| `data.items[].continue_freeze_details[].public_date` | String | 是 | 公示日期 |  |
| `data.items[].continue_freeze_details[].eid` | String | 是 | 被执行企业ID |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 36.53 注销备案

- Hub：`POST /api/v1/data/enterprise/36.53/query`；上游方法 GET；可调用
- 说明：企业注销备案信息，包括登记机关，清算组负责人，清算组成员，债权人公告，状态等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 分页跳过的记录数（默认为0）分页20 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].eid` | String | 是 | 企业eid |  |
| `data.items[].ename` | String | 是 | 企业名称 |  |
| `data.items[].credit_no` | String | 是 | 统一社会信用代码/注册号 |  |
| `data.items[].belong_org` | String | 是 | 登记机关 |  |
| `data.items[].audit_reg_date` | String | 是 | 清算组备案日期 |  |
| `data.items[].audit_start_date` | String | 是 | 清算组成立日期 |  |
| `data.items[].logout_reason` | String | 是 | 注销原因 |  |
| `data.items[].audit_address` | String | 是 | 清算组办公地址 |  |
| `data.items[].audit_leader` | String | 是 | 清算组负责人 |  |
| `data.items[].audit_employees` | String | 是 | 清算组成员 |  |
| `data.items[].creditor_start_date` | String | 是 | 债权人公告开始日期 |  |
| `data.items[].creditor_end_date` | String | 是 | 债权人公告结束日期 |  |
| `data.items[].creditor_announcement` | String | 是 | 公告内容 |  |
| `data.items[].creditor_person` | String | 是 | 债权申报联系人 |  |
| `data.items[].creditor_address` | String | 是 | 债权申报地址 |  |
| `data.items[].cancel_date` | String | 是 | 终止注销决议日期 |  |
| `data.items[].status` | String | 是 | 状态（2：已撤销 ；非2：已发布） |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 69.75 外部黑名单

- Hub：`POST /api/v1/data/enterprise/69.75/query`；上游方法 GET；可调用
- 说明：通过企业名称获取多源企业黑名单负面信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].name` | String | 是 | 企业名称 |  |
| `data.items[].eid` | String | 是 | 企业id |  |
| `data.items[].department_level` | String | 是 | 认定部门等级，枚举值为：国家级 、省级、市级、县级、乡级、其他 |  |
| `data.items[].lists_type` | String | 是 | 黑名单类型，01政府黑名单 02环保失信黑名单 03应急管理部安全生产失信黑名单 04政府采购黑名单 05“屡禁不止、屡罚不改”黑名单 06 其他 07 假冒国企名单 08 军队采购失信名单 09 政府采购失信名单 10 供应商暂停名单 11 社会组织活动异常名录 12 社会组织严重违法失信名单 13 涉金融领域黑名单 14 价格招采信用评价失信名单 15拖欠农民工工资失信联合惩戒对象16 交通运输行业黑名单 17 军队采购预警黑名单 |  |
| `data.items[].black_basis` | String | 是 | 黑名单认定依据 |  |
| `data.items[].maintain_department` | String | 是 | 认定部门 |  |
| `data.items[].credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.items[].in_lists_date` | String | 是 | 列入黑名单日期，排序字段 |  |
| `data.items[].out_lists_date` | String | 是 | 移出黑名单日期 |  |
| `data.items[].punishment_result` | String | 是 | 处罚结果 |  |
| `data.items[].details` | String | 是 | 失信情形 |  |
| `data.items[].is_history` | String | 是 | 是否历史 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 23.47 涉嫌冒用他人身份登记信息

- Hub：`POST /api/v1/data/enterprise/23.47/query`；上游方法 GET；可调用
- 说明：企业涉嫌冒用他人身份登记信息，包括冒名登记事项、当事人姓名、冒名登记时间、处理结果、处理原因及作出决定信息等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |
| `data.items` | Array | 是 | 涉嫌冒用他人身份登记信息详细信息列表 |  |
| `data.items[].ename` | String | 是 | 企业名称 |  |
| `data.items[].item` | String | 是 | 冒名登记事项 |  |
| `data.items[].name` | String | 是 | 当事人姓名 |  |
| `data.items[].date` | String | 是 | 冒名登记时间 |  |
| `data.items[].telephone` | String | 是 | 登记机关联系方式 |  |
| `data.items[].notice_start` | String | 是 | 公告期自 |  |
| `data.items[].notice_end` | String | 是 | 公告期至 |  |
| `data.items[].result` | String | 是 | 处理结果 |  |
| `data.items[].reason` | String | 是 | 处理原因 |  |
| `data.items[].department` | String | 是 | 做出决定机关 |  |
| `data.items[].decide_date` | String | 是 | 做出决定时间 |  |
| `data.items[].is_history` | String | 是 | 是否历史 |  |

## 经营信息


### 39.2 行政许可

- Hub：`POST /api/v1/data/enterprise/39.2/query`；上游方法 GET；可调用
- 说明：工商行政许可信息，包括许可文件编号、名称、机关及期限等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 行政许可列表 |  |
| `data.items[].source` | string | 是 | 来源，工商，信用中国，其他 |  |
| `data.items[].content` | String | 是 | 内容 |  |
| `data.items[].name` | String | 是 | 许可文件名称 |  |
| `data.items[].department` | String | 是 | 许可机关 |  |
| `data.items[].itemId` | Number | 是 | 编号 |  |
| `data.items[].disabled` | String | 是 | 是否当前公示，0：当前公示信息；1：历史公示信息 |  |
| `data.items[].startDate` | String | 是 | 开始日期 |  |
| `data.items[].number` | String | 是 | 许可文件编号 |  |
| `data.items[].endDate` | String | 是 | 结束日期 |  |
| `data.items[].status` | String | 是 | 其他 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 38.2 抽查检查

- Hub：`POST /api/v1/data/enterprise/38.2/query`；上游方法 GET；可调用
- 说明：企业抽查检查信息，包括检查编号以及实施机关等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 抽查检查列表 |  |
| `data.items[].date` | String | 是 | 日期 |  |
| `data.items[].id` | String | 是 | 检查抽查编号 |  |
| `data.items[].disabled` | String | 是 | 是否历史 |  |
| `data.items[].result` | String | 是 | 结果 |  |
| `data.items[].result_type` | String | 是 | 结果类型，1:通过 0:不通过 -1:未知 |  |
| `data.items[].department` | String | 是 | 检查实施机关 |  |
| `data.items[].type` | String | 是 | 类型 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 52.1 纳税A级

- Hub：`POST /api/v1/data/enterprise/52.1/query`；上游方法 GET；可调用
- 说明：企业历年A级纳税人记录，包括企业信用年份及信用等级等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全称或者企业注册号或者企业信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.credit_no` | String | 是 | 企业统一社会信用代码 |  |
| `data.grade_list` | Array | 是 | 信用等级列表 |  |
| `data.grade_list[].year` | String | 是 | 信用年份 |  |
| `data.grade_list[].assess_unit` | String | 是 | 评价单位 |  |
| `data.grade_list[].grade` | String | 是 | 信用等级（A） |  |
| `data.name` | String | 是 | 企业名称 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 21.4 招投标列表

- Hub：`POST /api/v1/data/enterprise/21.4/query`；上游方法 GET；可调用
- 说明：企业招投标列表，包括招投标ID、标题，招标单位、中标单位、以及其他与招投标项目相关的其他角色列表等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `type` | String | 否 | 公告类型 ，入参填对应数字，支持多填， 以英文逗号,隔开 10 拟建公告 20 招标公告 30 中标公告 0 未知 |
| `role` | String | 否 | 角色 ，入参填对应数字，支持多填，以 英文逗号,隔开 10 招采单位/建设单位（公告类型为拟 建，一般称为建设单位） 20 代理单位 30 中标单位 40 中标候选人 50 其他相关企业 51投标单位 |
| `publish_year` | String | 否 | 发布年份，例如填入 2021，则返回该企业 2021 年的招投标信息 |
| `skip` | Number | 否 | 跳过条目数（默认为 0） 分页使用，单次返回 20 条记录，第一页 skip=0，第二页 skip=20，以此类推获取 下一页数据 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].id` | String | 是 | 招投标 id |  |
| `data.items[].title` | String | 是 | 招投标标题 |  |
| `data.items[].type` | String | 是 | 公告类型 |  |
| `data.items[].date` | String | 是 | 发布时间 |  |
| `data.items[].tender` | String | 是 | 招标单位列表，字符串数组 |  |
| `data.items[].tender.name` | String | 是 | 招标机构名称 |  |
| `data.items[].tender.contacts` | Array | 是 | 联系人 |  |
| `data.items[].tender.phones` | Array | 是 | 联系手机号 |  |
| `data.items[].tender.address` | Array | 是 | 联系地址 |  |
| `data.items[].tender.email` | Array | 是 | 邮箱 |  |
| `data.items[].tender.eid` | String | 是 | 企业 id |  |
| `data.items[].agency` | String | 是 | 代理机构列表，字符串数组 |  |
| `data.items[].agency.name` | String | 是 | 代理机构名称 |  |
| `data.items[].agency.contacts` | Array | 是 | 联系人 |  |
| `data.items[].agency.phones` | Array | 是 | 联系手机号 |  |
| `data.items[].agency.address` | Array | 是 | 联系地址 |  |
| `data.items[].agency.email` | Array | 是 | 邮箱 |  |
| `data.items[].agency.eid` | String | 是 | 企业 id |  |
| `data.items[].winner` | String | 是 | 中标单位列表，字符串数组 |  |
| `data.items[].winner.name` | String | 是 | 中标机构名称 |  |
| `data.items[].winner.project_bid_money` | String | 是 | 中标金额 |  |
| `data.items[].winner.contacts` | Array | 是 | 联系人 |  |
| `data.items[].winner.phones` | Array | 是 | 联系手机号 |  |
| `data.items[].winner.address` | Array | 是 | 联系地址 |  |
| `data.items[].winner.email` | Array | 是 | 邮箱 |  |
| `data.items[].winner.eid` | String | 是 | 企业 id |  |
| `data.items[].proj_num` | String | 是 | 工程号/采购编号 |  |
| `data.items[].status` | String | 是 | 招投标状态 |  |
| `data.items[].province` | String | 是 | 省份 |  |
| `data.items[].area_name` | String | 是 | 地区名称 |  |
| `data.items[].role` | Number | 是 | 角色枚举值如下： 10 招采单位/建设单位（公告类型为拟建， 一般称为建设单位） 20 代理单位 30 中标单位 40 中标候选人 50 其他相关企业 51 投标单位 |  |
| `data.nums` | Number | 是 | 当前返回列表的总条数 |  |

### 21.6 招投标详情

- Hub：`POST /api/v1/data/enterprise/21.6/query`；上游方法 GET；可调用
- 说明：企业招投标详情，中标单位列表，以及具体招标信息正文及来源等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | String | 是 | 招投标id |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.tender` | String | 是 | 招标单位列表，数组字符串 |  |
| `data.tender.name` | String | 是 | 招标机构名称 |  |
| `data.tender.contacts` | Array | 是 | 联系人 |  |
| `data.tender.phones` | Array | 是 | 联系手机号 |  |
| `data.tender.address` | Array | 是 | 联系地址 |  |
| `data.tender.email` | Array | 是 | 邮箱 |  |
| `data.tender.eid` | String | 是 | 企业 id |  |
| `data.date` | String | 是 | 发布时间 |  |
| `data.id` | String | 是 | 招投标id |  |
| `data.content` | String | 是 | 正文 |  |
| `data.proj_num` | String | 是 | 工程号/采购编号 |  |
| `data.nace_code` | String | 是 | 行业代码 |  |
| `data.nace` | String | 是 | 招标行业标签 |  |
| `data.title` | String | 是 | 招投标标题 |  |
| `data.tender_method` | String | 是 | 招标采购方式 |  |
| `data.url` | String | 是 | 来源链接 | 🔗 |
| `data.winner` | String | 是 | 中标单位列表，数组字符串 |  |
| `data.winner.name` | String | 是 | 中标机构名称 |  |
| `data.winner.project_bid_money` | String | 是 | 中标金额 |  |
| `data.winner.contacts` | Array | 是 | 联系人 |  |
| `data.winner.phones` | Array | 是 | 联系手机号 |  |
| `data.winner.address` | Array | 是 | 联系地址 |  |
| `data.winner.email` | Array | 是 | 邮箱 |  |
| `data.agency` | String | 是 | 代理机构列表，数组字符串 |  |
| `data.agency.name` | String | 是 | 招标机构名称 |  |
| `data.agency.contacts` | Array | 是 | 联系人 |  |
| `data.agency.phones` | Array | 是 | 联系手机号 |  |
| `data.agency.address` | Array | 是 | 联系地址 |  |
| `data.agency.email` | Array | 是 | 邮箱 |  |
| `data.agency.eid` | String | 是 | 企业 id |  |
| `data.location` | String | 是 | 地区 |  |
| `data.type` | String | 是 | 公告类型 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 11.1 招聘信息

- Hub：`POST /api/v1/data/enterprise/11.1/query`；上游方法 GET；可调用
- 说明：企业招聘信息，包括招聘企业名称、职位、薪水、职位描述等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 招聘信息列表 |  |
| `data.items[].salary` | String | 是 | 薪水 |  |
| `data.items[].size` | String | 是 | 企业规模 |  |
| `data.items[].education` | String | 是 | 教育程度 |  |
| `data.items[].source` | String | 是 | 来源 |  |
| `data.items[].employer_type` | String | 是 | 企业类型 |  |
| `data.items[].name` | String | 是 | 企业名称 |  |
| `data.items[].welfare` | String | 是 | 福利 |  |
| `data.items[].number` | String | 是 | 招聘人数 |  |
| `data.items[].end_date` | String | 是 | 有效日期 |  |
| `data.items[].title` | String | 是 | 招聘职位 |  |
| `data.items[].job_type` | String | 是 | 职位类型 |  |
| `data.items[].description` | String | 是 | 职位描述 |  |
| `data.items[].url` | String | 是 | 招聘地址 | 🔗 |
| `data.items[].years` | String | 是 | 工作年限 |  |
| `data.items[].location` | String | 是 | 工作地点 |  |
| `data.items[].date` | String | 是 | 发布日期 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 53.1 进出口企业查询

- Hub：`POST /api/v1/data/enterprise/53.1/query`；上游方法 GET；可调用
- 说明：企业海关进出口企业的登记信息，包括进出口企业的海关编号、注册海关、经营类别等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | Number | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表。若为空，则返回{}结构 |  |
| `data.industry_type` | String | 是 | 行业种类 |  |
| `data.reg_area` | String | 是 | 工商注册地址 |  |
| `data.vail_date` | String | 是 | 报关有效期 |  |
| `data.annual_report` | String | 是 | 年报情况 |  |
| `data.url` | String | 是 | 数据来源 | 🔗 |
| `data.credit_levels` | Array | 是 | 信用等级列表 |  |
| `data.credit_levels[].original_credit` | String | 是 | 原信用等级 |  |
| `data.credit_levels[].after_credit` | String | 是 | 调整后信用等级 |  |
| `data.credit_levels[].reset_time` | String | 是 | 调整时间 |  |
| `data.credit_levels[].reason` | String | 是 | 调整原因 |  |
| `data.u_tags` | Number | 是 | 0正常；1历史 |  |
| `data.initial_ename` | String | 是 | 海关登记企业名称 |  |
| `data.administrative_divisions` | String | 是 | 行政区划 |  |
| `data.ename` | String | 是 | 企业名称 |  |
| `data.economic_regions` | String | 是 | 经济区划 |  |
| `data.business_category` | String | 是 | 经营类别 |  |
| `data.cancel_flag` | String | 是 | 海关注销标志 |  |
| `data.reg_date` | String | 是 | 注册日期 |  |
| `data.customs_reg` | String | 是 | 注册海关 |  |
| `data.credit_levels_new` | String | 是 | 信用等级（新） |  |
| `data.special_area` | String | 是 | 特殊贸易区域 |  |
| `data.punishments` | Array | 是 | 行政处罚列表 |  |
| `data.punishments[].case_type` | String | 是 | 案件类型 |  |
| `data.punishments[].case_litigant` | String | 是 | 处罚主体 |  |
| `data.punishments[].case_no` | String | 是 | 案号 |  |
| `data.punishments[].case_date` | String | 是 | 处罚日期 |  |
| `data.customs_num` | String | 是 | 海关编号 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 76.1 简易注销

- Hub：`POST /api/v1/data/enterprise/76.1/query`；上游方法 GET；可调用
- 说明：简易注销信息列表，包括登记机关、异议信息、简易注销结果等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 简易注销信息列表 |  |
| `data.items[].gs_sca_result` | String | 是 | 简易注销结果 |  |
| `data.items[].notice_period` | String | 是 | 公告期 |  |
| `data.items[].url` | String | 是 | 全体投资人承诺书（地址） | 🔗 |
| `data.items[].name` | String | 是 | 企业名称 |  |
| `data.items[].gs_sca_objections` | String | 是 | 异议信息 |  |
| `data.items[].department` | String | 是 | 登记机关 |  |
| `data.items[].is_history` | Number | 是 | 是否历史（0否；1是） |  |
| `data.items[].result_code` | Number | 是 | 注销结果代码（0：空或者其他，1：准予注销/正在进行公告，2：不予注销/已撤销/届满未提起注销申请） |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 52.3 纳税人类型

- Hub：`POST /api/v1/data/enterprise/52.3/query`；上游方法 GET；可调用
- 说明：纳税人类型信息，包括一般纳税人、小规模纳税人等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全称/企业注册号/企业信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Array | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data[].qualification` | String | 是 | 资格类型 |  |
| `data[].judge_date` | String | 是 | 登记时间 |  |
| `data[].name` | String | 是 | 姓名 |  |
| `data[].eid` | String | 是 | 企业id |  |
| `data[].tax_num` | String | 是 | 纳税人识别号 |  |
| `data[].manage_organ` | String | 是 | 主营税务机关 |  |
| `data[].state` | String | 是 | 纳税人状态 |  |
| `data[].has_qualific` | String | 是 | 是否有一般纳税人资格，枚举说明：1：是一般纳税人，0：不是一纳税人 |  |
| `data[].common_taxpayer` | String | 是 | 纳税人类型，1：一般纳税人 0：小规模纳税人 -1：其他 |  |
| `data[].start_date` | String | 是 | 有效起始日期 |  |
| `data[].end_date` | String | 是 | 有效截止日期 |  |

### 43.4 主体信用评级

- Hub：`POST /api/v1/data/enterprise/43.4/query`；上游方法 GET；可调用
- 说明：包括该企业历年主体信用评级类型、信用等级、评级机构等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业名称/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.name` | String | 是 | 企业名称 |  |
| `data.id` | String | 是 | 企业ID |  |
| `data.items` | Array | 是 | 历年主体信用评级列表 |  |
| `data.items[].info_code` | String | 是 | 公告编码 |  |
| `data.items[].rating` | String | 是 | 信用等级 |  |
| `data.items[].ratingdate` | String | 是 | 评级日期 |  |
| `data.items[].ratetype` | Number | 是 | 评级类型 |  |
| `data.items[].ratefwd` | Number | 是 | 评级展望 |  |
| `data.items[].itype` | Number | 是 | 机构当事人属性 |  |
| `data.items[].noticedate` | String | 是 | 披露日期 |  |
| `data.items[].creditname` | String | 是 | 评级机构 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 43.5 债券信用评级

- Hub：`POST /api/v1/data/enterprise/43.5/query`；上游方法 GET；可调用
- 说明：包括该企业历年债券评级类型、信用等级、评级机构等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业名称/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 历年债券信用评级列表 |  |
| `data.items[].changedate` | String | 是 | 评级日期 |  |
| `data.items[].noticedate` | String | 是 | 披露日期 |  |
| `data.items[].rating` | String | 是 | 信用等级 |  |
| `data.items[].ratingstyle` | String | 是 | 评级方式 |  |
| `data.items[].ratingtype` | String | 是 | 评级类型 |  |
| `data.items[].ratingfwd` | Number | 是 | 评级展望 |  |
| `data.items[].changeway` | String | 是 | 评级变动方向 |  |
| `data.items[].creditname` | String | 是 | 资信评估机构 |  |
| `data.id` | String | 是 | 企业ID |  |
| `data.name` | String | 是 | 企业名称 |  |

### 38.3 双随机抽查

- Hub：`POST /api/v1/data/enterprise/38.3/query`；上游方法 GET；可调用
- 说明：双随机抽查，包括抽查名称、抽查类型、抽查机关等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 双随机抽查列表 |  |
| `data.items[].details` | String | 是 | 详情列表（seqno：序号，raninsCheckResName：检查结果，raninsItemName：检查事项，is_abnormal：是否异常） |  |
| `data.items[].raninsTaskName` | String | 是 | 抽查任务名称 |  |
| `data.items[].raninsPlanId` | String | 是 | 抽查计划编号 |  |
| `data.items[].raninsTaskId` | String | 是 | 抽查任务编号 |  |
| `data.items[].insDate` | String | 是 | 抽查完成日期 |  |
| `data.items[].insAuth` | String | 是 | 抽查机关 |  |
| `data.items[].raninsPlaneName` | String | 是 | 抽查计划名称 |  |
| `data.items[].raninsTypeName` | String | 是 | 抽查类型 |  |
| `data.items[].abnormalInfo` | String | 是 | 检查结果是否异常0：非异常，1：异常 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 79.16 微信公众号

- Hub：`POST /api/v1/data/enterprise/79.16/query`；上游方法 GET；可调用
- 说明：根据企业全名/注册号/统一社会信用代码获得企业公众号相关信息。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].we_id` | String | 是 | 微信公众号 id |  |
| `data.items[].we_name` | String | 是 | 微信公众号名称 |  |
| `data.items[].description` | String | 是 | 微信公众号描述 |  |
| `data.items[].qrcode_url` | String | 是 | 二维码 url | 🔗 |
| `data.items[].logo_url` | String | 是 | logo url | 🔗 |
| `data.items[].org_we_id` | String | 是 | 原始微信公众号 id |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 79.15 环境信用评级

- Hub：`POST /api/v1/data/enterprise/79.15/query`；上游方法 GET；可调用
- 说明：根据企业全名/注册号/统一社会信用代码获得环境信用评价等级相关信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `year` | Number | 否 | 评级年份（YYYY） |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `sign` | string | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 环保评级清单 |  |
| `data.items[].credit` | String | 是 | 评价等级 |  |
| `data.items[].standard_credit` | String | 是 | 标准化评价等级 |  |
| `data.items[].year` | Number | 是 | 评级年份 |  |
| `data.items[].district` | String | 是 | 评级地区 |  |
| `data.items[].publish_date` | String | 是 | 发布时间 |  |
| `message` | string | 是 | 返回结果消息 |  |

### 79.32 园区信息

- Hub：`POST /api/v1/data/enterprise/79.32/query`；上游方法 GET；可调用
- 说明：根据园区名称获得园区的详细信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `park_name` | String | 是 | 园区名称 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `sign` | string | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.park_name` | String | 是 | 园区名称 |  |
| `data.province` | String | 是 | 省份 |  |
| `data.city` | String | 是 | 城市 |  |
| `data.district` | String | 是 | 区域 |  |
| `data.area` | Number | 是 | 占地面积（单位：亩） |  |
| `data.longitude` | Number | 是 | 经度 |  |
| `data.latitude` | Number | 是 | 纬度 |  |
| `data.industry` | String | 是 | 产业集群 |  |
| `data.ent_num` | Number | 是 | 园区内企业数量 |  |
| `message` | string | 是 | 返回结果消息 |  |

### 79.31 企业所属园区

- Hub：`POST /api/v1/data/enterprise/79.31/query`；上游方法 GET；可调用
- 说明：根据企业全名/注册号/统一社会信用代码获得企业所属园区的相关信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `sign` | string | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 所属园区列表 |  |
| `data.items[].park_name` | String | 是 | 园区名称 |  |
| `data.items[].province` | String | 是 | 省份 |  |
| `data.items[].city` | String | 是 | 城市 |  |
| `data.items[].district` | String | 是 | 区域 |  |
| `data.items[].area` | Number | 是 | 占地面积（单位：亩） |  |
| `data.items[].longitude` | Number | 是 | 经度 |  |
| `data.items[].latitude` | Number | 是 | 纬度 |  |
| `data.items[].industry` | String | 是 | 产业集群 |  |
| `message` | string | 是 | 返回结果消息 |  |

### 79.33 园区企业

- Hub：`POST /api/v1/data/enterprise/79.33/query`；上游方法 GET；可调用
- 说明：根据园区名称获得园区内企业的相关信息。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `park_name` | String | 是 | 园区名称 |
| `status_code` | String | 否 | 企业状态（1：存续；2：注销；3：吊销；4：撤销，5：迁出，6：设立中，7：清算中，8：停业，9：其他 ,10：空，11：歇业，12：责令关闭；13：已取缔非法社会组织；14：涉嫌非法社会组织） 支持同时输入多个，多个数字传入用英文,号隔开 |
| `start_date` | String | 否 | 园区内企业成立时间范围，如2022-01-01,2024-01-01 用英文逗号","进行日期分隔 ·如果只输入一个日期，返回输入日期到当前最新数据 · 如果输入了一个日期包含了分隔符,则报208 · 不输入日期,返回所有数据 |
| `skip` | Number | 否 | 跳过条目数（默认为 0，最大值 9999） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `sign` | string | 是 | 数据签名 |  |
| `data` | object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | items 列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 园区企业列表 |  |
| `data.items[].name` | String | 是 | 企业全称 |  |
| `data.items[].credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.items[].regist_capi_new` | Number | 是 | 注册资本（万元） |  |
| `data.items[].oper_name` | String | 是 | 法定代表人 |  |
| `data.items[].start_date` | String | 是 | 成立日期 |  |
| `data.items[].scope` | String | 是 | 经营范围 |  |
| `data.items[].disabled` | String | 是 | 有效性（0：有效；1：无效） |  |
| `message` | string | 是 | 返回结果消息 |  |

### 66.33 财产线索查询

- Hub：`POST /api/v1/data/enterprise/66.33/query`；上游方法 GET；可调用
- 说明：根据企业全名/注册号/统一社会信用代码获取财产线索

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 财产线索查询列表 |  |
| `data.items[].change_time` | String | 是 | 变更时间 |  |
| `data.items[].business_time` | String | 是 | 业务披露时间 |  |
| `data.items[].property_flow` | String | 是 | 财产流向。包含疑似流入、疑似流出、流 向未知 |  |
| `data.items[].property_type` | String | 是 | 财产类型，见附录property_type |  |
| `data.items[].clue_type` | String | 是 | 线索类型，见附录clue_type |  |
| `data.items[].type` | String | 是 | 维度 |  |
| `data.items[].related_id` | String | 是 | 各维度关联信息 id |  |
| `data.items[].details` | Object | 是 | 具体内容 |  |
| `data.items[].execute_difficulty` | String | 是 | 执行难易度。包含难度较低、难度中等、 难度较高 |  |
| `data.items[].u_tags` | String | 是 | 是否历史。0-非历史，1-历史 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 95.16 产品质量监督抽查结果

- Hub：`POST /api/v1/data/enterprise/95.16/query`；上游方法 GET（可选 GET/POST）；可调用
- 说明：产品质量监督抽查结果信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `producer_name` | String | 是 | 生产商企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 分页跳过的记录数（默认为0）分页20 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].producer_name` | String | 是 | 生产商名称 |  |
| `data.items[].manufacturer_name` | String | 是 | 制造商名称 |  |
| `data.items[].province` | String | 是 | 制造商所在地 |  |
| `data.items[].product_name` | String | 是 | 产品名称 |  |
| `data.items[].product_detail_name` | String | 是 | 产品详情名称 |  |
| `data.items[].model` | String | 是 | 规格型号 |  |
| `data.items[].level` | String | 是 | 产品等级 |  |
| `data.items[].number` | String | 是 | 生产日期/批号 |  |
| `data.items[].unqualified_project` | String | 是 | 主要不合格项目 |  |
| `data.items[].inspection_institution` | String | 是 | 承检机构 |  |
| `data.items[].check_year` | String | 是 | 抽查时间 |  |
| `data.items[].check_type` | String | 是 | 抽查类型 |  |
| `data.items[].check_department` | String | 是 | 抽查组织单位 |  |
| `data.items[].result` | Number | 是 | 抽查结果（未知：-1；不合格：0；合格：1） |  |
| `data.items[].is_history` | Number | 是 | 是否历史（0否1是） |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 57.83 进出口信用评级

- Hub：`POST /api/v1/data/enterprise/57.83/query`；上游方法 GET；可调用
- 说明：查询企业的进出口信用评级，海关注册编码，企业信用认定时间、企业信用认定等级等信息。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 分页跳过的记录数（默认为0）分页20 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].ename` | String | 是 | 公司名 |  |
| `data.items[].credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.items[].customs_num` | String | 是 | 海关注册编码 |  |
| `data.items[].credit_levels_new` | String | 是 | 信用等级 |  |
| `data.items[].credit_num` | String | 是 | 认证证书编码 |  |
| `data.items[].credit_time` | String | 是 | 认定日期 |  |
| `data.items[].customs_reg` | String | 是 | 注册海关 |  |
| `data.items[].business_category` | String | 是 | 经营类别 |  |
| `data.items[].reg_date` | String | 是 | 注册日期 |  |
| `data.items[].administrative_divisions` | String | 是 | 行政区划 |  |
| `data.items[].economic_regions` | String | 是 | 经济区划 |  |
| `data.items[].special_area` | String | 是 | 特殊贸易区域 |  |
| `data.items[].industry_type` | String | 是 | 行业种类 |  |
| `data.items[].vail_date` | String | 是 | 报关有效期 |  |
| `data.items[].elect_type` | String | 是 | 跨境贸易电子商务类型 |  |
| `data.items[].cancel_flag` | String | 是 | 海关注销标志 |  |
| `data.items[].annual_report` | String | 是 | 年报情况 |  |
| `data.items[].eid` | String | 是 | 企业id |  |
| `data.items[].first_record_date` | String | 是 | 最早备案日期 |  |
| `data.items[].new_record_date` | String | 是 | 最新备案日期 |  |
| `data.items[].u_tags` | String | 是 | 0正常；1历史 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 88.24 企业所属开发区

- Hub：`POST /api/v1/data/enterprise/88.24/query`；上游方法 GET；可调用
- 说明：根据企业全名得企业所属开发区的相关信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 分页跳过的记录数（默认为0）分页20 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].ename` | String | 是 | 企业名称 |  |
| `data.items[].eid` | String | 是 | 企业唯一标识eid |  |
| `data.items[].zone_code` | String | 是 | 开发区代码 |  |
| `data.items[].zone_name` | String | 是 | 开发区名称 |  |
| `data.items[].is_history` | String | 是 | 是否历史 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 36.38 开发区基本信息

- Hub：`POST /api/v1/data/enterprise/36.38/query`；上游方法 GET；可调用
- 说明：根据开发区名称获取开发区代码、主导产业、开发区类型等相关信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `zone_name` | String | 是 | 开发区名称 |
| `skip` | Number | 否 | 分页跳过的记录数（默认为0）分页20 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].zone_code` | String | 是 | 开发区代码 |  |
| `data.items[].zone_name` | String | 是 | 开发区名称 |  |
| `data.items[].ratify_date` | String | 是 | 批准时间 |  |
| `data.items[].approval_area` | String | 是 | 核准面积（公顷） |  |
| `data.items[].major_industries` | String | 是 | 主导产业 |  |
| `data.items[].zone_type` | String | 是 | 开发区类型 |  |
| `data.items[].zone_level` | String | 是 | 开发区级别 |  |
| `data.items[].province` | String | 是 | 所属地区 |  |
| `data.items[].district_code` | String | 是 | 行政区划代码 |  |
| `data.items[].subordinated_streets` | String | 是 | 开发区管辖街道名称 |  |
| `data.items[].longitude` | String | 是 | 开发区定位经度 |  |
| `data.items[].latitude` | String | 是 | 开发区定位纬度 |  |
| `data.items[].is_history` | String | 是 | 是否历史 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 96.51 开发区企业

- Hub：`POST /api/v1/data/enterprise/96.51/query`；上游方法 GET；可调用
- 说明：根据开发区名称获取开发区企业全称、统一社会信用代码、法定代表人等企业信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `zone_name` | String | 是 | 开发区名称 |
| `skip` | Number | 否 | 分页跳过的记录数（默认为0）分页20 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].name` | String | 是 | 企业全称 |  |
| `data.items[].credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.items[].regist_capi` | String | 是 | 注册资本（万元） |  |
| `data.items[].currency_unit` | String | 是 | 货币单位 |  |
| `data.items[].oper_name` | String | 是 | 法定代表人 |  |
| `data.items[].start_date` | String | 是 | 成立日期 |  |
| `data.items[].scope` | String | 是 | 经营范围 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 15.72 票据承兑

- Hub：`POST /api/v1/data/enterprise/15.72/query`；上游方法 GET；可调用
- 说明：

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].ename` | String | 是 | 承兑人名称 |  |
| `data.items[].eid` | String | 是 | 承兑人id |  |
| `data.items[].closing_date` | String | 是 | 披露信息时点日期 |  |
| `data.items[].account_name` | String | 是 | 承兑人开户机构 |  |
| `data.items[].account_id` | String | 是 | 承兑人开户机构id |  |
| `data.items[].amount_add` | String | 是 | 累计承兑发生额 |  |
| `data.items[].amount_remain` | String | 是 | 承兑余额 |  |
| `data.items[].overdue_add` | String | 是 | 累计逾期发生额 |  |
| `data.items[].overdue_remain` | String | 是 | 逾期余额 |  |
| `data.items[].medium` | String | 是 | 票据介质 |  |
| `data.items[].release_date` | String | 是 | 披露日期 |  |
| `data.items[].s_remark` | String | 是 | 系统备注 |  |
| `data.items[].e_remark` | String | 是 | 企业备注 |  |
| `data.items[].is_history` | String | 是 | 是否历史；0：否，1：是 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 23.48 营销商机线索

- Hub：`POST /api/v1/data/enterprise/23.48/query`；上游方法 GET；可调用
- 说明：获取企业营销商机线索信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数）skip最大限制为：9980 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `sign` | String | 否 | 数据签名 |  |
| `status` | String | 否 | 返回结果状态 |  |
| `message` | String | 否 | 返回结果消息 |  |
| `data` | Object | 否 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 否 | 返回列表中记录总数 |  |
| `data.num` | Number | 否 | 本次调用返回记录数 |  |
| `data.items` | Array | 否 | 商机列表 |  |
| `data.items[].eid` | String | 否 | 企业id |  |
| `data.items[].name` | String | 否 | 企业名称 |  |
| `data.items[].user_type` | String | 否 | 服务客群 |  |
| `data.items[].tag` | String | 否 | 业务标签（E000 银行拓客 E001 存款 E002 授信 E003 开户 E004 其他） |  |
| `data.items[].type` | String | 否 | 线索详细类型 |  |
| `data.items[].time` | String | 否 | 事件时间 |  |
| `data.items[].info` | String | 否 | 详细信息 |  |
| `data.items[].grade` | String | 否 | 线索等级 |  |
| `data.items[].district_code` | String | 否 | 企业区域 |  |
| `data.items[].url` | String | 否 | 线索来源url | 🔗 |
| `data.items[].description` | String | 否 | 商机描述 |  |

### 52.68 纳税人状态

- Hub：`POST /api/v1/data/enterprise/52.68/query`；上游方法 GET；可调用
- 说明：查询企业纳税人状态信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认不填返回前20条，skip=20取第21～40条，以此类推） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果；未匹配到企业或目标企业无有效纳税人状态记录时，返回total=0、num=0、items=[] |  |
| `data.total` | Number | 是 | 符合条件的记录数 |  |
| `data.num` | Number | 是 | 本次返回记录数 |  |
| `data.items` | Array | 是 | 纳税人状态信息列表 |  |
| `data.items[].ename` | String | 是 | 企业名称 |  |
| `data.items[].name` | String | 是 | 纳税人名称 |  |
| `data.items[].tax_num` | String | 是 | 纳税人识别号 |  |
| `data.items[].manage_organ` | String | 是 | 主管税务机关 |  |
| `data.items[].state` | String | 是 | 纳税人状态 |  |
| `data.items[].status_code` | String | 是 | 纳税人状态编码 |  |
| `data.items[].is_history` | String | 是 | 是否历史 |  |

## 知识产权


### 79.37 知识产权统计

- Hub：`POST /api/v1/data/enterprise/79.37/query`；上游方法 GET；可调用
- 说明：根据企业名称/统一社会信用代码/注册号获取知识产权统计信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.patent_num` | number | 是 | 专利信息统计 |  |
| `data.trademark_num` | number | 是 | 商标信息统计 |  |
| `data.copyright_num` | number | 是 | 著作权统计（不含软著） |  |
| `data.cert_num` | number | 是 | 资质认证统计 |  |
| `data.software_num` | number | 是 | 软件著作权统计 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 12.1 商标列表

- Hub：`POST /api/v1/data/enterprise/12.1/query`；上游方法 GET；可调用
- 说明：企业商标列表信息，包括商标名称，企业名称、状态等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 商标信息列表 |  |
| `data.items[].steps` | Array | 是 | 商标流程信息 |  |
| `data.items[].steps[].date` | String | 是 | 商标流程日期 |  |
| `data.items[].steps[].step` | String | 是 | 商标流程内容 |  |
| `data.items[].id` | String | 是 | 商标ID |  |
| `data.items[].image_name` | String | 是 | 商标图片链接 | 🔗 |
| `data.items[].status` | String | 是 | 状态 |  |
| `data.items[].trademark_status_simplified` | String | 是 | 商标状态(简化) |  |
| `data.items[].agent` | String | 是 | 代理人名称 |  |
| `data.items[].apply_date` | String | 是 | 申请日期 |  |
| `data.items[].reg_number` | String | 是 | 商标注册编号，该参数为12.4商标详情的入参 |  |
| `data.items[].period` | String | 是 | 专用权期限 |  |
| `data.items[].name` | String | 是 | 商标名称 |  |
| `data.items[].type_name` | String | 是 | 分类名 |  |
| `data.items[].products` | Array | 是 | 产品服务信息 |  |
| `data.items[].products[].num` | String | 是 | 商品的类似群 |  |
| `data.items[].products[].name` | String | 是 | 商标的商品名称 |  |
| `data.items[].company` | String | 是 | 企业名称 |  |
| `data.items[].type_num` | String | 是 | 分类码 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 12.4 商标详细

- Hub：`POST /api/v1/data/enterprise/12.4/query`；上游方法 GET；可调用
- 说明：企业商标详细信息，包括商标名称、申请时间、申请人、流程状态等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `number` | String | 是 | 商标注册编号 |
| `type_num` | String | 否 | 商标分类编号 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.notices` | Array | 是 | 商标公告信息 |  |
| `data.notices[].date` | String | 是 | 商标公告日期 |  |
| `data.notices[].content` | String | 是 | 商标公告内容 |  |
| `data.notices[].url` | String | 是 | 商标公告链接 | 🔗 |
| `data.first_pubno` | String | 是 | 初审公告期号 |  |
| `data.image_url` | String | 是 | 商标图片链接 | 🔗 |
| `data.image_name` | String | 是 | 图片名称 |  |
| `data.status` | String | 是 | 状态 |  |
| `data.trademark_status_simplified` | String | 是 | 商标状态(简化) |  |
| `data.company_en` | String | 是 | 公司名称（英文） |  |
| `data.end_date` | String | 是 | 专用权截止日期 |  |
| `data.agent` | String | 是 | 代理人名称 |  |
| `data.created_time` | String | 是 | 数据创建时间 |  |
| `data.address_en` | String | 是 | 申请人地址（英文） |  |
| `data.name` | String | 是 | 商标名称 |  |
| `data.priority_date` | String | 是 | 优先权日期 |  |
| `data.color` | String | 是 | 颜色组合/指定颜色 |  |
| `data.company` | String | 是 | 公司名称 |  |
| `data.type_num` | String | 是 | 分类码 |  |
| `data.last_special_date` | String | 是 | 后期指定日期 |  |
| `data.address_cn` | String | 是 | 申请人地址（中文） |  |
| `data.start_date` | String | 是 | 开始日期(专用权期限) |  |
| `data.reg_pubdate` | String | 是 | 注册公告日期 |  |
| `data.steps` | Array | 是 | 商标流程信息 |  |
| `data.steps[].date` | String | 是 | 商标流程日期 |  |
| `data.steps[].step` | String | 是 | 商标流程内容 |  |
| `data.org_image_url` | String | 是 | 商标图片链接 | 🔗 |
| `data.reg_number` | String | 是 | 注册号 |  |
| `data.first_pubdate` | String | 是 | 初审公告日期 |  |
| `data.period` | String | 是 | 专用权期限 |  |
| `data.ename` | String | 是 | 企业名称 |  |
| `data.url` | String | 是 | 详细页链接 | 🔗 |
| `data.reg_pubno` | String | 是 | 注册公告期号 |  |
| `data.trademarktype` | String | 是 | 商标类型 |  |
| `data.is_shared` | String | 是 | 是否共有商标 |  |
| `data.apply_date` | String | 是 | 申请日期 |  |
| `data.global_date` | String | 是 | 国际注册日期 |  |
| `data.last_updated_time` | String | 是 | 最新更新时间 |  |
| `data.eid` | String | 是 | 企业id |  |
| `data.products` | Array | 是 | 产品服务信息 |  |
| `data.products[].num` | String | 是 | 商品的类似群 |  |
| `data.products[].name` | String | 是 | 商标的商品名称 |  |
| `data.element` | String | 是 | 图形要素 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 8.1 专利列表

- Hub：`POST /api/v1/data/enterprise/8.1/query`；上游方法 GET；可调用
- 说明：企业专利列表信息，包括专利ID、名称、类型等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |
| `role_code` | String | 否 | 角色类型（非必填，不填默认全部）1 专利权人 2 原始申请人 3 原始专利权人 |
| `role_history` | String | 否 | 历史标签（非必填，不填默认全部），0当前信息 1历史信息 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 专利信息列表 |  |
| `data.items[].patent_name` | String | 是 | 名称 |  |
| `data.items[].id` | String | 是 | 专利id |  |
| `data.items[].role` | String | 是 | 角色 |  |
| `data.items[].request_num` | String | 是 | 专利申请号 |  |
| `data.items[].request_date` | String | 是 | 申请日期 |  |
| `data.items[].type_name` | String | 是 | 类型 |  |
| `data.items[].role_history` | String | 是 | 历史角色标签（0；否，1：是。当前企业转为历史角色后置1；默认0） |  |
| `data.items[].authorize_date` | String | 是 | 授权公布日 |  |
| `data.items[].outhor_date` | String | 是 | 公布公告日 |  |
| `data.items[].app_person` | String | 是 | 原始申请人 |  |
| `data.items[].outhor_num` | String | 是 | 公布公告号 |  |
| `data.items[].authorize_tag` | String | 是 | 授权标志（0：发明专利未授权；1：发明专利已授权；2：实用新型和外观设计） |  |
| `data.items[].ipc_name` | String | 是 | IPC详情 |  |
| `data.items[].agent` | String | 是 | 专业代理机构 |  |
| `data.items[].last_status` | String | 是 | 最新法律状态 |  |
| `data.items[].authorize_num` | String | 是 | 授权公告号 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 8.4 专利详细

- Hub：`POST /api/v1/data/enterprise/8.4/query`；上游方法 GET；可调用
- 说明：企业专利详细信息，包括专利ID、名称、类型等基本信息，以及专利详细信息，诸如发明人、申请人等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `number` | String | 是 | 专利申请号 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.patent_name` | String | 是 | 名称 |  |
| `data.brief` | String | 是 | 详细信息 |  |
| `data.outhor_num` | String | 是 | 公布公告号 |  |
| `data.request_num` | String | 是 | 申请号 |  |
| `data.designer` | String | 是 | 发明人 |  |
| `data.type_name` | String | 是 | 类型 |  |
| `data.category_num` | String | 是 | 分类号 |  |
| `data.agent` | String | 是 | 专利代理机构 |  |
| `data.patent_person` | String | 是 | 申请人 |  |
| `data.outhor_date` | String | 是 | 公布公告日 |  |
| `data.authorize_date` | String | 是 | 授权公告日 |  |
| `data.request_date` | String | 是 | 申请日期 |  |
| `data.agent_people` | String | 是 | 代理人 |  |
| `data.annex` | String | 是 | 附件 | 🔗 |
| `data.authorize_tag` | String | 是 | 授权标志（0：发明专利未授权；1：发明专利已授权；2：实用新型和外观设计） |  |
| `data.patent_img` | String | 是 | 专利图片 | 🔗 |
| `data.last_status` | String | 是 | 最新法律状态 |  |
| `data.authorize_num` | String | 是 | 授权公告号 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 79.25 电信许可

- Hub：`POST /api/v1/data/enterprise/79.25/query`；上游方法 GET；可调用
- 说明：根据企业全名/注册号/统一社会信用代码获得企业电信许可相关信息。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 电信许可列表 |  |
| `data.items[].lic_no` | String | 是 | 许可证号 |  |
| `data.items[].lic_detail` | Array | 是 | 许可证种类和范围 |  |
| `data.items[].lic_detail[].pro_kind` | String | 是 | 业务种类 |  |
| `data.items[].lic_detail[].scope` | String | 是 | 覆盖范围 |  |
| `data.items[].report_name` | String | 是 | 公示年报企业名称 |  |
| `data.items[].credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.items[].oper_name` | String | 是 | 法定代表人 |  |
| `data.items[].reg_address` | String | 是 | 注册住所 |  |
| `data.items[].reg_province` | String | 是 | 注册属地 |  |
| `data.items[].reg_capi` | Number | 是 | 注册资本（元） |  |
| `data.items[].lic_type` | String | 是 | 许可证业务种类 |  |
| `data.items[].ent_nature` | String | 是 | 企业性质 |  |
| `data.items[].is_quoted` | String | 是 | 上市情况 |  |
| `data.items[].comp_phone` | String | 是 | 客户投诉服务电话 |  |
| `data.items[].comp_num` | Number | 是 | 用户投诉量 |  |
| `data.items[].comp_reply` | Number | 是 | 用户投诉回复率（%） |  |
| `sign` | string | 是 | 数据签名 |  |
| `status` | string | 是 | 接口调用状态 |  |
| `message` | string | 是 | 返回结果消息 |  |

### 79.24 金融资质

- Hub：`POST /api/v1/data/enterprise/79.24/query`；上游方法 GET；可调用
- 说明：根据企业全名/注册号/统一社会信用代码获得金融资质相关信息。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `sign` | string | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.items` | String | 是 | 资质类型 |  |
| `data.items.cert_type` | String | 是 | 资质类型 |  |
| `data.items.ins_no` | String | 是 | 机构编码 |  |
| `data.items.ins_type_l1` | String | 是 | 机构类型（一级） |  |
| `data.items.ins_type_l2` | String | 是 | 机构类型（二级） |  |
| `data.items.ins_type_l3` | String | 是 | 机构类型（三级） |  |
| `data.items.regulator_l1` | String | 是 | 监管机构（一级） |  |
| `data.items.regulator_l2` | String | 是 | 监管机构（二级） |  |
| `data.items.serial_no` | String | 是 | 证件流水号 |  |
| `data.items.establish_date` | String | 是 | 批准成立日期 |  |
| `data.items.cert_date` | String | 是 | 发证日期 |  |
| `data.items.abbreviation` | String | 是 | 机构简称 |  |
| `data.items.ename_en` | String | 是 | 英文名称 |  |
| `data.items.address` | String | 是 | 机构地址 |  |
| `data.items.location` | String | 是 | 机构所在地 |  |
| `data.items.postal_code` | String | 是 | 邮政编码 |  |
| `data.items.issue_org` | String | 是 | 发证机关 |  |
| `data.items.busi_scope` | String | 是 | 业务范围说明 |  |
| `data.items.serial_no_before` | String | 是 | 变更前流水号 |  |
| `data.items.ins_no_before` | String | 是 | 变更前机构编码 |  |
| `data.items.name_before` | String | 是 | 变更前机构名称 |  |
| `data.items.address_before` | String | 是 | 变更前机构地址 |  |
| `message` | string | 是 | 返回结果消息 |  |

### 14.1 著作权

- Hub：`POST /api/v1/data/enterprise/14.1/query`；上游方法 GET；可调用
- 说明：企业作品著作权信息，包括著作ID、名称、类型、登记批准时间，著作持有企业等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |
| `approval_date_start` | String | 否 | 登记批准起始日期（格式：YYYY-MM-DD） |
| `approval_date_end` | String | 否 | 登记批准截止日期（格式：YYYY-MM-DD） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 著作权列表 |  |
| `data.items[].short_name` | String | 是 | 简称 |  |
| `data.items[].id` | String | 是 | 著作ID |  |
| `data.items[].created_time` | String | 是 | 启信宝收录日期 |  |
| `data.items[].type` | String | 是 | 著作类型 |  |
| `data.items[].first_date` | String | 是 | 首次发表日期 |  |
| `data.items[].name` | String | 是 | 著作名称 |  |
| `data.items[].number` | String | 是 | 著作注册号 |  |
| `data.items[].version` | String | 是 | 版本号 |  |
| `data.items[].type_name` | String | 是 | 著作类型名称 |  |
| `data.items[].related_companies` | Array | 是 | 相关企业信息 |  |
| `data.items[].related_companies[].name` | String | 是 | 相关企业名称 |  |
| `data.items[].related_companies[].item` | String | 是 | 该字段作废不再使用，结构仍保留 |  |
| `data.items[].related_companies[].by` | String | 是 | 该字段作废不再使用，结构仍保留 |  |
| `data.items[].type_num` | String | 是 | 分类号 |  |
| `data.items[].last_updated_time` | String | 是 | 最后更新时间 |  |
| `data.items[].company` | String | 是 | 著作持有企业 |  |
| `data.items[].approval_date` | String | 是 | 著作批准时间 |  |
| `data.items[].success_date` | String | 是 | 著作完成时间 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 15.1 软件著作权

- Hub：`POST /api/v1/data/enterprise/15.1/query`；上游方法 GET；可调用
- 说明：企业软件著作权信息，包括软件著作ID、名称、类型、登记批准时间，软件著作持有企业等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].id` | String | 是 | 软件著作ID |  |
| `data.items[].number` | String | 是 | 软件著作注册号 |  |
| `data.items[].company` | String | 是 | 软件著作持有企业 |  |
| `data.items[].version` | String | 是 | 版本号 |  |
| `data.items[].type` | String | 是 | 软件著作类型 |  |
| `data.items[].name` | String | 是 | 软件著作名称 |  |
| `data.items[].type_name` | String | 是 | 软件著作类型名称 |  |
| `data.items[].type_num` | String | 是 | 分类号 |  |
| `data.items[].success_date` | String | 是 | 软件著作完成时间 |  |
| `data.items[].approval_date` | String | 是 | 登记批准日期 |  |
| `data.items[].related_companies` | Array | 是 | 相关企业信息 |  |
| `data.items[].related_companies[].name` | String | 是 | 相关企业名称 |  |
| `data.items[].short_name` | String | 是 | 简称 |  |
| `data.items[].last_updated_time` | String | 是 | 最后更新时间 |  |
| `data.items[].first_date` | String | 是 | 首次发表日期 |  |
| `data.items[].created_time` | String | 是 | 启信宝收录日期 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 16.1 域名信息

- Hub：`POST /api/v1/data/enterprise/16.1/query`；上游方法 GET；可调用
- 说明：企业备案域名信息，有网站名称、域名等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 域名列表 |  |
| `data.items[].home_url` | String | 是 | 主页URL | 🔗 |
| `data.items[].ename` | String | 是 | 命名企业名称 |  |
| `data.items[].domain` | String | 是 | 域名 | 🔗 |
| `data.items[].site_name` | String | 是 | 网站名称 |  |
| `data.items[].eid` | String | 是 | 企业ID |  |
| `data.items[].company` | String | 是 | 企业名称 |  |
| `data.items[].last_updated_time` | String | 是 | 最后更新时间 |  |
| `data.items[].check_date` | String | 是 | 核查日期 |  |
| `data.items[].number` | String | 是 | 网站备案许可号 |  |
| `data.items[].type` | String | 是 | 主办单位性质 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 22.1 资质信息

- Hub：`POST /api/v1/data/enterprise/22.1/query`；上游方法 GET；可调用
- 说明：企业资质证书信息，有资质证书类型、证书编号、发证截止日期等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |
| `type` | String | 否 | 资质证书类型（见附件） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 资质证书信息列表 |  |
| `data.items[].num` | String | 是 | 证书编号 |  |
| `data.items[].remarks` | String | 是 | 备注 |  |
| `data.items[].status` | String | 是 | 状态 |  |
| `data.items[].type` | String | 是 | 资质证书类型 |  |
| `data.items[].issue_date` | String | 是 | 发证时间 |  |
| `data.items[].validity_end` | String | 是 | 截止日期 |  |
| `data.items[].issue_unit` | String | 是 | 发证机关 |  |
| `data.items[].kind_id` | String | 是 | 启信宝资质证书内部id |  |
| `data.items[].kind` | String | 是 | 用于获取资质证书详情，kind=001食品添加剂生产许可证 ； kind=002食品生产许可证； kind=003 药品经营企业； kind=004 GMP,GSP认证； kind=005 互联网药品信息； kind=006 药品生产企业； kind=007 医疗器械生产企业； kind=008 医疗器械经营； kind=009 化妆品生产许可信息；kind=010 质量管理体系认证的获取，kind=011 食品经营许可证，kind=012排污许可证、kind=013安全生产许可证、kind=014CCC产品认证，kind=015软件产品评估认证，kind=016工业产品生产许可证，kind=017特种设备公示信息，其他资质证书返回"-" |  |
| `data.items[].status_code` | String | 是 | 状态代码，1:有效；2：注销；3：过期；4：暂停；5：撤销；6：失效；7：未知 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 22.11 资质证书详情

- Hub：`POST /api/v1/data/enterprise/22.11/query`；上游方法 GET；可调用
- 说明：通过证书编号或者kind_id获取资质证书详情（目前支持kind=001食品添加剂生产许可证 kind=002食品生产许可证 kind=003 药品经营企业 kind=004 GMP,GSP认证 kind=005 互联网药品信息 kind=006 药品生产企业 kind=007 医疗器械生产企业 kind=008 医疗器械经营 kind=009 化妆品生产许可 kind=010 质量管理体系认证，kind=011 食品经营许可证,kind=012排污许可证、kind=013安全生产许可证、kind=014C

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `kind` | String | 是 | kind=001食品添加剂生产许可证 kind=002食品生产许可证 kind=003 药品经营企业 kind=004 GMP,GSP认证 kind=005 互联网药品信息 kind=006 药品生产企业 kind=007 医疗器械生产企业 kind=008 医疗器械经营 kind=009 化妆品生产许可 kind=010 质量管理体系认证，kind=011 食品经营许可证,kind=012排污许可证、kind=013安全生产许可证、kind=014CCC产品认证、kind=015软件产品评估认证、kind=016工业产品生产许可证、kind=017特种设备公示信息 |
| `kind_id` | String | 否 | 启信宝资质证书内部id，用于获取资质证书详情，非必填（kind_id与register_no必须选填其一，如果都填，优先register_no入参查询） |
| `register_no` | String | 否 | 官方证书编号，用于获取资质证书详情，非必填（kind_id与register_no必须选填其一，如果都填，优先register_no入参查询） |

kind_id 与 register_no 至少提供一个。

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.type` | String | 是 | 证书类型kind=001食品添加剂生产许可证返回以下数据字段： |  |
| `data.lic_no` | String | 是 | 证书编号 |  |
| `data.province` | String | 是 | 省份 |  |
| `data.production` | String | 是 | 产品名称 |  |
| `data.issue_org` | String | 是 | 上报部门 |  |
| `data.validity_start` | String | 是 | 发证日期yyyy-mm-dd |  |
| `data.validity_end` | String | 是 | 有效期至yyyy-mm-dd |  |
| `data.prod_address` | String | 是 | 生产地址 |  |
| `data.state_code` | String | 是 | 证书状态编码（1:有效；2：注销；3：过期；4：暂停；5：撤销；6：失效；7：其他） |  |
| `data.address` | String | 是 | 住所 |  |
| `data.detail` | String | 是 | 明细 |  |
| `data.is_history` | String | 是 | 是否历史（0：否；1：是） |  |
| `data.state` | String | 是 | 许可证状态 |  |
| `data.type` | String | 是 | 证书类型kind=002食品生产许可证返回以下数据字段： |  |
| `data.producer` | String | 是 | 生产企业 |  |
| `data.lic_no` | String | 是 | 证书编号 |  |
| `data.cert_type` | String | 是 | 证书类别（1：SC；2：QS） |  |
| `data.category` | String | 是 | SC食品类别 |  |
| `data.product_name` | String | 是 | QS产品名称 |  |
| `data.check_type` | String | 是 | QS检验方式 |  |
| `data.issue_org` | String | 是 | 发证机关 |  |
| `data.validity_start` | String | 是 | 发证日期yyyy-mm-dd |  |
| `data.validity_end` | String | 是 | 有效期至yyyy-mm-dd |  |
| `data.prod_address` | String | 是 | 生产地址 |  |
| `data.oper_name` | String | 是 | 法定代表人/负责人 |  |
| `data.credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.address` | String | 是 | 住所 |  |
| `data.administration` | String | 是 | SC日常监督管理机构 |  |
| `data.administrator` | String | 是 | SC日常监督管理人员 |  |
| `data.signer` | String | 是 | SC签发人 |  |
| `data.details` | Array | 是 | SC许可明细 |  |
| `data.details[].category` | String | 是 | 许可明细 - 食品、食品添加剂类别 |  |
| `data.details[].category_no` | String | 是 | 许可明细 - 类别编号 |  |
| `data.details[].category_name` | String | 是 | 许可明细 - 类别名称 |  |
| `data.details[].category_detail` | String | 是 | 许可明细 - 品种明细 |  |
| `data.details[].remark` | String | 是 | 许可明细 - 备注 |  |
| `data.state` | String | 是 | 许可证状态 |  |
| `data.level` | String | 是 | 级别（0：省级；1：国家） |  |
| `data.composition` | String | 是 | 许可明细（原始） |  |
| `data.is_history` | String | 是 | 是否历史（0-否，1-是） |  |
| `data.state_code` | String | 是 | 证书状态编码（1:有效；2：注销；3：过期；4：暂停；5：撤销；6：失效；7：其他） |  |
| `data.type` | String | 是 | 证书类型kind=003 药品经营企业返回以下数据字段： |  |
| `data._id` | String | 是 | 资质详情id |  |
| `data.license_name` | String | 是 | 证书名称 |  |
| `data.registered_address` | String | 是 | 注册地址 |  |
| `data.warehouse_address` | String | 是 | 仓库地址 |  |
| `data.principal` | String | 是 | 企业负责人 |  |
| `data.business_type` | String | 是 | 经营方式 |  |
| `data.business_scope` | String | 是 | 经营范围 |  |
| `data.valid_start` | String | 是 | 发证日期 |  |
| `data.valid_end` | String | 是 | 有效期至 |  |
| `data.issue_unit` | String | 是 | 发证机关 |  |
| `data.state_code` | String | 是 | 证书状态编码（1:有效；2：注销；3：过期；4：暂停；5：撤销；6：失效；7：其他） |  |
| `data.is_history` | String | 是 | 是否历史（0：否；1：是） |  |
| `data.type` | String | 是 | 证书类型kind=004 GMP,GSP认证返回以下数据字段： |  |
| `data._id` | String | 是 | 资质详情id |  |
| `data.province_city` | String | 是 | 省市 |  |
| `data.province_city_code` | String | 是 | 省市代码 |  |
| `data.register_no` | String | 是 | 证书编号 |  |
| `data.license_name` | String | 是 | 证书名称 |  |
| `data.certif_scope` | String | 是 | 认证范围 |  |
| `data.valid_start` | String | 是 | 发证日期 |  |
| `data.valid_end` | String | 是 | 有效期截至 |  |
| `data.continue_date` | String | 是 | 批准延续日期 |  |
| `data.extend_date` | String | 是 | 有效期延续至 |  |
| `data.continue_scope` | String | 是 | 批准延续认证范围 |  |
| `data.gmp_version` | String | 是 | 认证GMP版本 |  |
| `data.issue_unit` | String | 是 | 发证机构 |  |
| `data.state_code` | String | 是 | 证书状态编码（1:有效；2：注销；3：过期；4：暂停；5：撤销；6：失效；7：其他） |  |
| `data.is_history` | String | 是 | 是否历史（0：否；1：是） |  |
| `data.type` | String | 是 | 证书类型kind=005 互联网药品信息回以下数据字段： |  |
| `data._id` | String | 是 | 资质详情id |  |
| `data.license_name` | String | 是 | 证书名称 |  |
| `data.register_no` | String | 是 | 证书编号 |  |
| `data.valid_start` | String | 是 | 发证日期 |  |
| `data.valid_end` | String | 是 | 有效期至 |  |
| `data.state_code` | String | 是 | 证书状态编码（1:有效；2：注销；3：过期；4：暂停；5：撤销；6：失效；7：其他） |  |
| `data.service_kind` | String | 是 | 服务性质 |  |
| `data.oper_name` | String | 是 | 法定代表 |  |
| `data.website_oper` | String | 是 | 网站负责人 |  |
| `data.history` | String | 是 | 变更历史记录 |  |
| `data.website` | String | 是 | 网站域名 | 🔗 |
| `data.issue_organ` | String | 是 | 发证机关 |  |
| `data.address` | String | 是 | 地址 |  |
| `data.postcode` | String | 是 | 邮编 |  |
| `data.is_history` | String | 是 | 是否历史（0：否；1：是） |  |
| `data.type` | String | 是 | 证书类型kind=006 药品生产企业返回以下数据字段： |  |
| `data._id` | String | 是 | 资质详情id |  |
| `data.license_name` | String | 是 | 证书名称 |  |
| `data.register_no` | String | 是 | 证书编号 |  |
| `data.province` | String | 是 | 省份 |  |
| `data.province_code` | String | 是 | 省份代码 |  |
| `data.agency_people` | String | 是 | 法定代表人 |  |
| `data.principal` | String | 是 | 企业负责人 |  |
| `data.quality_people` | String | 是 | 质量负责人 |  |
| `data.registered_address` | String | 是 | 注册地址 |  |
| `data.production_address` | String | 是 | 生产地址 |  |
| `data.production_scope` | String | 是 | 生产范围 |  |
| `data.valid_start` | String | 是 | 发证日期 |  |
| `data.valid_end` | String | 是 | 有效期至 |  |
| `data.state_code` | String | 是 | 证书状态编码（1:有效；2：注销；3：过期；4：暂停；5：撤销；6：失效；7：其他） |  |
| `data.issue_unit` | String | 是 | 发证机关 |  |
| `data.signer` | String | 是 | 签发人 |  |
| `data.sup_agency` | String | 是 | 日常监管机构 |  |
| `data.sup_staff` | String | 是 | 日常监管人员 |  |
| `data.telephone` | String | 是 | 监督举报电话 |  |
| `data.is_history` | String | 是 | 是否历史（0：否；1：是） |  |
| `data.type` | String | 是 | 证书类型kind=007 医疗器械生产企业返回以下数据字段： |  |
| `data._id` | String | 是 | 资质详情id |  |
| `data.register_no` | String | 是 | 证书编号 |  |
| `data.license_name` | String | 是 | 证书名称 |  |
| `data.oper_name` | String | 是 | 企业法定代表人 |  |
| `data.principal` | String | 是 | 企业负责人 |  |
| `data.address` | String | 是 | 住所 |  |
| `data.production_address` | String | 是 | 生产地址 |  |
| `data.scope` | String | 是 | 生产范围 |  |
| `data.department` | String | 是 | 发证机关/备案部门 |  |
| `data.valid_start` | String | 是 | 有效起始日期 |  |
| `data.valid_end` | String | 是 | 截止日期 |  |
| `data.state_code` | String | 是 | 证书状态编码（1:有效；2：注销；3：过期；4：暂停；5：撤销；6：失效；7：其他） |  |
| `data.date` | String | 是 | 发证日期/备案日期 |  |
| `data.is_history` | String | 是 | 是否历史（0：否；1：是） |  |
| `data.type` | String | 是 | 证书类型kind=008医疗器械经营返回以下数据字段： |  |
| `data._id` | String | 是 | 资质详情id |  |
| `data.register_no` | String | 是 | 证书编号 |  |
| `data.license_name` | String | 是 | 证书名称 |  |
| `data.oper_name` | String | 是 | 企业法定代表人 |  |
| `data.principal` | String | 是 | 企业负责人 |  |
| `data.address` | String | 是 | 住所 |  |
| `data.production_address` | String | 是 | 经营场所 |  |
| `data.business_type` | String | 是 | 经营方式 |  |
| `data.scope_2002` | String | 是 | 经营范围(2002) |  |
| `data.scope_2017` | String | 是 | 经营范围(2017) |  |
| `data.store_address` | String | 是 | 库房地址 |  |
| `data.department` | String | 是 | 发证机关/备案部门 |  |
| `data.valid_start` | String | 是 | 有效起始日期 |  |
| `data.valid_end` | String | 是 | 有效期限 |  |
| `data.state_code` | String | 是 | 证书状态编码（1:有效；2：注销；3：过期；4：暂停；5：撤销；6：失效；7：其他） |  |
| `data.date` | String | 是 | 发证日期/备案日期 |  |
| `data.is_history` | String | 是 | 是否历史（0：否；1：是） |  |
| `data.type` | String | 是 | 证书类型kind=009 化妆品生产许可信息返回以下数据字段： |  |
| `data._id` | String | 是 | 资质详情id |  |
| `data.license_name` | String | 是 | 证书名称 |  |
| `data.register_no` | String | 是 | 证书编号 |  |
| `data.address` | String | 是 | 企业地址 |  |
| `data.warehouse_address` | String | 是 | 仓库地址 |  |
| `data.agency_people` | String | 是 | 法定代表人 |  |
| `data.principal` | String | 是 | 企业负责人 |  |
| `data.quality_people` | String | 是 | 质量负责人 |  |
| `data.permit_item` | String | 是 | 许可项目 |  |
| `data.valid_start` | String | 是 | 发证日期 |  |
| `data.valid_end` | String | 是 | 有效期至 |  |
| `data.issue_unit` | String | 是 | 发证机关 |  |
| `data.signer` | String | 是 | 签发人 |  |
| `data.sup_agency` | String | 是 | 日常监管机构 |  |
| `data.sup_staff` | String | 是 | 日常监管人员 |  |
| `data.state_code` | String | 是 | 证书状态编码（1:有效；2：注销；3：过期；4：暂停；5：撤销；6：失效；7：其他） |  |
| `data.telephone` | String | 是 | 监督举报电话 |  |
| `data.is_history` | String | 是 | 是否历史 |  |
| `data.type` | String | 是 | 证书类型kind=010 质量管理体系认证返回以下数据字段： |  |
| `data._id` | String | 是 | 资质详情id |  |
| `data.fugai_scope` | String | 是 | 认证覆盖的业务范围 |  |
| `data.fugai_address` | String | 是 | 认证覆盖的场所名称及地址 |  |
| `data.register_no` | String | 是 | 证书编号 |  |
| `data.type` | String | 是 | 证书类别 |  |
| `data.license_name` | String | 是 | 证书名称 |  |
| `data.valid_start` | String | 是 | 颁证日期 |  |
| `data.valid_end` | String | 是 | 证书到期日期 |  |
| `data.state_code` | String | 是 | 证书状态编码（1:有效；2：注销；3：过期；4：暂停；5：撤销；6：失效；7：其他） |  |
| `data.certification_basis` | String | 是 | 认证依据 |  |
| `data.agency_name` | String | 是 | 发证机构名称 |  |
| `data.agency_scope` | String | 是 | 发证结构业务范围 |  |
| `data.change_date` | String | 是 | 变更日期 |  |
| `data.revocation_date` | String | 是 | 撤销日期 |  |
| `data.logout_date` | String | 是 | 注销日期 |  |
| `data.first_date` | String | 是 | 初次获证日期 |  |
| `data.item` | String | 是 | 认证项目 |  |
| `data.out_reason` | String | 是 | 撤销原因 |  |
| `data.change_cert_date` | String | 是 | 换证日期 |  |
| `data.url` | String | 是 | 来源网址 | 🔗 |
| `data.is_history` | String | 是 | 是否历史（0：否；1：是） |  |
| `data.shangbao_date` | String | 是 | 信息上报日期 |  |
| `data.market` | String | 是 | 证书使用的认可标识 |  |
| `data.agency_no` | String | 是 | 发证机构批准号 |  |
| `data.agency_date` | String | 是 | 发证机构有效期 |  |
| `data.agency_phone` | String | 是 | 发证机构电话 |  |
| `data.agency_domain` | String | 是 | 发证机构网址 | 🔗 |
| `data.agency_status` | String | 是 | 发证机构状态 |  |
| `data.agency_address` | String | 是 | 发证机构地址 |  |
| `data.monitoring_times` | String | 是 | 监督次数 |  |
| `data.re_certification_times` | String | 是 | 再认证次数 |  |
| `data.is_multiplace` | String | 是 | 是否覆盖多场所 |  |
| `data.change_type` | String | 是 | 变更类别 |  |
| `data.organization_name` | String | 是 | 获证组织/生产企业名称 |  |
| `data.organization_eid` | String | 是 | 获证组织/生产企业eid |  |
| `data.organization_area` | String | 是 | 获证组织所在国别和地区 |  |
| `data.organization_people` | String | 是 | 本证书体系覆盖人数 |  |
| `data.organization_no` | String | 是 | 获证组织统一社会信用代码/组织机构代码 |  |
| `data.organization_address` | String | 是 | 获证组织地址 |  |
| `data.production_info` | String | 是 | 产品信息 |  |
| `data.change_history` | String | 是 | 历史变更轨迹[{num:序号,item:认证活动,discrimination:概要描述,happen_date:发生时间,check:审核组,shangbao_date:上报日期,note:数据修改声明}] |  |
| `data.type` | String | 是 | kind=011 食品经营许可证时返回以下字段 |  |
| `data._id` | String | 是 | 资质详情id |  |
| `data.license_name` | String | 是 | 证书名称 |  |
| `data.register_no` | String | 是 | 许可证编号 |  |
| `data.credit_no` | String | 是 | 社会信用代码 |  |
| `data.oper_name` | String | 是 | 法定代表人 |  |
| `data.address` | String | 是 | 住所 |  |
| `data.business_place` | String | 是 | 经营场所 |  |
| `data.identity` | String | 是 | 主体业态 |  |
| `data.operation_item` | String | 是 | 经营项目 |  |
| `data.institution_name` | String | 是 | 日常监督管理机构 |  |
| `data.people_name` | String | 是 | 日常监督管理人员 |  |
| `data.telephone` | String | 是 | 投诉举报电话 |  |
| `data.department` | String | 是 | 发证机关 |  |
| `data.signer` | String | 是 | 签发人 |  |
| `data.valid_start` | String | 是 | 发证日期 |  |
| `data.valid_end` | String | 是 | 有效期至 |  |
| `data.state` | String | 是 | 状态说明 |  |
| `data.state_code` | String | 是 | 证书状态编码 |  |
| `data.related_companies` | Array | 是 | 关联企业 |  |
| `data.url` | String | 是 | 来源网址 | 🔗 |
| `data.is_history` | String | 是 | 是否历史（0：否；1：是） |  |
| `data.type` | String | 是 | kind=012排污许可证时返回以下字段 |  |
| `data._id` | String | 是 | 资质详情id |  |
| `data.license_name` | String | 是 | 证书名称 |  |
| `data.register_no` | String | 是 | 许可证编号 |  |
| `data.ename_ori` | String | 是 | 企业原始名称 |  |
| `data.valid_start` | String | 是 | 发证日期 |  |
| `data.valid_end` | String | 是 | 有效期至 |  |
| `data.state_code` | String | 是 | 证书状态编码（1:有效；2：注销；3：过期；4：暂停；5：撤销；6：失效；7：其他） |  |
| `data.province` | String | 是 | 省份 |  |
| `data.city` | String | 是 | 城市 |  |
| `data.address` | String | 是 | 地址 |  |
| `data.industry` | String | 是 | 行业类别 |  |
| `data.area` | String | 是 | 所在地区 |  |
| `data.issue_unit` | String | 是 | 发证机关 |  |
| `data.steps` | String | 是 | 证书业务流程 |  |
| `data.main_pollutants` | String | 是 | 主要污染物类别 |  |
| `data.atmosphere_pollutants_kind` | String | 是 | 大气主要污染物种类 |  |
| `data.atmosphere_pollutants_law` | String | 是 | 大气污染物排放规律 |  |
| `data.atmosphere_pollutants_standard` | String | 是 | 大气污染物排放执行标准 |  |
| `data.water_pollutants_kind` | String | 是 | 废水主要污染物种类 |  |
| `data.water_pollutants_law` | String | 是 | 废水污染物排放规律 |  |
| `data.water_pollutants_standard` | String | 是 | 废水污染物排放执行标准 |  |
| `data.use_right` | String | 是 | 排污权使用和交易信息 |  |
| `data.report` | String | 是 | 执行报告 |  |
| `data.supervise_info` | String | 是 | 监督执法信息 |  |
| `data.self_monitor_info` | String | 是 | 自行监测信息 |  |
| `data.pic1_url_oss` | String | 是 | 排污许可证正本链接(oss) | 🔗 |
| `data.pic2_url_oss` | String | 是 | 排污许可证副本链接(oss) | 🔗 |
| `data.reason` | String | 是 | 原因（注销、撤销） |  |
| `data.date` | String | 是 | 时间（注销、撤销） |  |
| `data.manage_type` | String | 是 | 管理类别 |  |
| `data.url` | String | 是 | 链接 | 🔗 |
| `data.is_history` | String | 是 | 是否历史（0：否；1：是） |  |
| `data.type` | String | 是 | kind=013安全生产许可证时返回以下字段 |  |
| `data._id` | String | 是 | 资质详情id |  |
| `data.license_name` | String | 是 | 证书名称 |  |
| `data.register_no` | String | 是 | 许可证编号 |  |
| `data.register_form` | String | 是 | 证书形式（0：纸质；1：电子） |  |
| `data.agency_people` | String | 是 | 法人代表 |  |
| `data.credit_no` | String | 是 | 行政相对人代码/统一社会信用代码 |  |
| `data.register_address` | String | 是 | 注册地址 |  |
| `data.province` | String | 是 | 省份 |  |
| `data.economic_type` | String | 是 | 经济类型 |  |
| `data.permit_scope` | String | 是 | 许可范围 |  |
| `data.permit_agency` | String | 是 | 许可机关 |  |
| `data.valid_start` | String | 是 | 有效期开始 |  |
| `data.valid_end` | String | 是 | 有效期至 |  |
| `data.issue_date` | String | 是 | 核发日期 |  |
| `data.last_valid_date` | String | 是 | 前一次有效期 |  |
| `data.state_code` | String | 是 | 证书状态编码（1:有效；2：注销；3：过期；4：暂停；5：撤销；6：失效；7：其他） |  |
| `data.url` | String | 是 | 来源网址 | 🔗 |
| `data.is_history` | String | 是 | 是否历史（0：否；1：是） |  |
| `data.type` | String | 是 | kind=014CCC产品认证时返回以下字段 |  |
| `data._id` | String | 是 | 资质详情id |  |
| `data.license_name` | String | 是 | 证书名称 |  |
| `data.register_no` | String | 是 | 许可证编号 |  |
| `data.state_code` | String | 是 | 证书状态编码（1:有效；2：注销；3：过期；4：暂停；5：撤销；6：失效；7：其他） |  |
| `data.valid_start` | String | 是 | 发证日期 |  |
| `data.valid_end` | String | 是 | 到期日期 |  |
| `data.shangbao_date` | String | 是 | 信息上报日期 |  |
| `data.pro_type` | String | 是 | 产品类别 |  |
| `data.skill` | String | 是 | 认证标准和技术要求 |  |
| `data.product_name` | String | 是 | 产品名称 |  |
| `data.product_name_en` | String | 是 | 产品英文名称 |  |
| `data.unit_main` | String | 是 | 产品名称及单元（主） |  |
| `data.unit_se` | String | 是 | 产品名称及单元（次） |  |
| `data.model` | String | 是 | 规格型号 |  |
| `data.principal_name` | String | 是 | 认证委托人企业名称 |  |
| `data.principal_eid` | String | 是 | 认证委托人企业id |  |
| `data.principal_area` | String | 是 | 认证委托人所在国别地区 |  |
| `data.principal_code` | String | 是 | 认证委托人统一社会信用代码/组织机构代码 |  |
| `data.principal_address` | String | 是 | 认证委托人地址 |  |
| `data.producer_name` | String | 是 | 生产者企业名称 |  |
| `data.producer_eid` | String | 是 | 生产者企业id |  |
| `data.producer_area` | String | 是 | 生产者所在国别地区 |  |
| `data.producer_code` | String | 是 | 生产者统一社会信用代码/组织机构代码 |  |
| `data.producer_address` | String | 是 | 生产者地址 |  |
| `data.applicant` | String | 是 | 申请人中文名 |  |
| `data.applicant_en` | String | 是 | 申请人英文名 |  |
| `data.manufacturer_name` | String | 是 | 制造商中文名 |  |
| `data.manufacturer_en` | String | 是 | 制造商英文名 |  |
| `data.manufacturer_address` | String | 是 | 制造商地址 |  |
| `data.manufacturer_eid` | String | 是 | 制造商id |  |
| `data.agency_name` | String | 是 | 发证机构名称 |  |
| `data.agency_eid` | String | 是 | 发证机构eid |  |
| `data.agency_no` | String | 是 | 发证机构批准号 |  |
| `data.agency_date` | String | 是 | 发证机构有效期 |  |
| `data.agency_phone` | String | 是 | 发证机构电话 |  |
| `data.agency_domain` | String | 是 | 发证机构网址 | 🔗 |
| `data.agency_status` | String | 是 | 发证机构状态 |  |
| `data.agency_address` | String | 是 | 发证机构地址 |  |
| `data.agency_scope` | String | 是 | 发证结构业务范围 |  |
| `data.change_date` | String | 是 | 变更日期 |  |
| `data.revocation_date` | String | 是 | 撤销日期 |  |
| `data.logout_date` | String | 是 | 注销日期 |  |
| `data.first_date` | String | 是 | 初次获证日期 |  |
| `data.cert_change_date` | String | 是 | 证书状态变化时间 |  |
| `data.cert_change_reason` | String | 是 | 原因 |  |
| `data.self_declaration_no` | String | 是 | 转为自我声明后的编号 |  |
| `data.url` | String | 是 | 网址链接 | 🔗 |
| `data.is_history` | String | 是 | 是否历史（0：否；1：是） |  |
| `data.type` | String | 是 | kind=015软件产品评估认证时返回以下字段 |  |
| `data._id` | String | 是 | 资质详情id |  |
| `data.license_name` | String | 是 | 证书名称 |  |
| `data.register_no` | String | 是 | 证书编号 |  |
| `data.valid_start` | String | 是 | 发证日期 |  |
| `data.valid_end` | String | 是 | 有效期至 |  |
| `data.state` | String | 是 | 状态 |  |
| `data.state_code` | String | 是 | 证书状态编码（1:有效；2：注销；3：过期；4：暂停；5：撤销；6：失效；7：其他） |  |
| `data.ename_ori` | String | 是 | 原企业名称 |  |
| `data.product_name` | String | 是 | 现产品名称及版本号 |  |
| `data.product_name_ori` | String | 是 | 原产品名称 |  |
| `data.kind` | String | 是 | 软件类型 |  |
| `data.url` | String | 是 | 链接 | 🔗 |
| `data.is_history` | String | 是 | 是否历史（0：否；1：是） |  |
| `data.type` | String | 是 | kind=016工业产品生产许可证时返回以下字段 |  |
| `data._id` | String | 是 | 资质详情id |  |
| `data.license_name` | String | 是 | 证书名称 |  |
| `data.register_no` | String | 是 | 证书编号 |  |
| `data.product_model` | String | 是 | 产品规格 |  |
| `data.address` | String | 是 | 住所 |  |
| `data.production_address` | String | 是 | 生产地址 |  |
| `data.valid_start` | String | 是 | 发证日期 |  |
| `data.valid_end` | String | 是 | 有效期至 |  |
| `data.state` | String | 是 | 许可证状态 |  |
| `data.state_code` | String | 是 | 证书状态编码（1:有效；2：注销；3：过期；4：暂停；5：撤销；6：失效；7：其他） |  |
| `data.issue_unit` | String | 是 | 发证机构 |  |
| `data.province` | String | 是 | 省份 |  |
| `data.province_code` | String | 是 | 省份代码 |  |
| `data.attention` | String | 是 | 说明 |  |
| `data.detail` | String | 是 | 明细 |  |
| `data.permit_content` | String | 是 | 许可内容（北京源单独字段 [{\"category\": \"产品分类\", \"name\": \"产品名称\", \"detail\": \"产品明细\"}]） |  |
| `data.item_category` | String | 是 | 事项类别 |  |
| `data.issuing_authority` | String | 是 | 发证单元 |  |
| `data.product_name` | String | 是 | 产品名称 |  |
| `data.legal_representative` | String | 是 | 法定代表人 |  |
| `data.credit_no` | String | 是 | 社会信用代码 |  |
| `data.url` | String | 是 | 链接 | 🔗 |
| `data.is_history` | String | 是 | 是否历史（0：否；1：是；源网站找不到的数据为1；） |  |
| `data.type` | String | 是 | kind=017特种设备公示信息时返回以下字段 |  |
| `data._id` | String | 是 | 资质详情id |  |
| `data.license_name` | String | 是 | 证书名称 |  |
| `data.register_no` | String | 是 | 证书编号 |  |
| `data.valid_start` | String | 是 | 发证日期 |  |
| `data.valid_end` | String | 是 | 有效期至 |  |
| `data.state` | String | 是 | 许可证状态 |  |
| `data.state_code` | String | 是 | 证书状态编码（1:有效；2：注销；3：过期；4：暂停；5：撤销；6：失效；7：其他） |  |
| `data.company_name` | String | 是 | 单位名称 |  |
| `data.credit_no` | String | 是 | 社会信用代码 |  |
| `data.address` | String | 是 | 住所 |  |
| `data.category` | String | 是 | 单位类别 |  |
| `data.license_item` | String | 是 | 许可项目 |  |
| `data.institution` | String | 是 | 发证机构 |  |
| `data.public_date` | String | 是 | 公示日期 |  |
| `data.license_scope` | String | 是 | 许可范围 |  |
| `data.url` | String | 是 | 链接 | 🔗 |
| `data.is_history` | String | 是 | 是否历史（0：否；1：是；源网站找不到的数据为1；） |  |

### 79.21 标准制定

- Hub：`POST /api/v1/data/enterprise/79.21/query`；上游方法 GET；可调用
- 说明：通过企业名称/统一社会信用代码获取企业的标准制定详情

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |
| `standard_type_code` | Number | 否 | 标准类别代码（默认全部） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].standard_type` | String | 是 | 标准类别 |  |
| `data.items[].standard_number` | String | 是 | 标准号（国家标准计划代表计划号） |  |
| `data.items[].standard_name` | String | 是 | 标准名称（国家标准计划代表项目名称） |  |
| `data.items[].revision` | String | 是 | 制修订（仅国家标准计划、行业标准、地方标准 ） |  |
| `data.items[].program_schedule` | String | 是 | 项目进度（仅国家标准计划） |  |
| `data.items[].release_date` | String | 是 | 发布日期（国家标准计划代表计划下达日期） |  |
| `data.items[].execute_date` | String | 是 | 实施日期（国家标准计划无） |  |
| `data.items[].abandon_date` | String | 是 | 废止日期（国家标准计划、团队标准无） |  |
| `data.items[].standard_status` | String | 是 | 标准状态（国家标准计划无） |  |
| `data.items[].classify` | String | 是 | 分类（团队标准无） |  |
| `data.items[].standard_sort` | String | 是 | 标准类别（团队标准无） |  |
| `data.items[].group_name` | String | 是 | 团体名称（仅团体标准） |  |
| `data.items[].ccs` | String | 是 | 中国标准分类号 |  |
| `data.items[].ics` | Array | 是 | 国际标准分类列表 |  |
| `data.items[].ics[].code` | String | 是 | 国际标准分类号 |  |
| `data.items[].ics[].name` | String | 是 | 国际标准分类 |  |
| `sign` | string | 是 | 数据签名 |  |
| `status` | string | 是 | 接口调用状态 |  |
| `message` | string | 是 | 返回结果消息 |  |

### 22.6 工程资质资格

- Hub：`POST /api/v1/data/enterprise/22.6/query`；上游方法 GET；可调用
- 说明：企业工程资质资格信息，包括资质证书编号、发证机关、资质范围等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | String | 否 | 分页参数 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 工程资质信息列表 |  |
| `data.items[].lic_no` | String | 是 | 资质证书编号 |  |
| `data.items[].issue_org` | String | 是 | 发证机关 |  |
| `data.items[].lic_name` | Array | 是 | 资质名称 |  |
| `data.items[].updated_time` | String | 是 | 更新时间 |  |
| `data.items[].created_time` | String | 是 | 创建时间 |  |
| `data.items[].lic_scope` | String | 是 | 资质范围 |  |
| `data.items[].url` | String | 是 | 原文链接 | 🔗 |
| `data.items[].category` | String | 是 | 资质类别 |  |
| `data.items[].validity_start` | String | 是 | 发证日期 |  |
| `data.items[].validity_end` | String | 是 | 有效期至 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 22.10 高新技术企业资质

- Hub：`POST /api/v1/data/enterprise/22.10/query`；上游方法 GET；可调用
- 说明：高新技术企业资质信息，包括证书编号、发证截止日期以及状态等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 资质证书信息列表 |  |
| `data.items[].register_no` | String | 是 | 证书编号 |  |
| `data.items[].state` | String | 是 | 状态（枚举值：过期、有效、未知） |  |
| `data.items[].description` | String | 是 | 备注 |  |
| `data.items[].valid_end` | String | 是 | 截止日期 |  |
| `data.items[].valid_start` | String | 是 | 发证日期 |  |
| `data.items[].public_status` | String | 是 | 高新资质公示状态 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 22.3 食品生产许可证SC

- Hub：`POST /api/v1/data/enterprise/22.3/query`；上游方法 GET；可调用
- 说明：企业食品生产许可证SC信息，包括证书类型、发证机关、许可明细等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 食品许可证SC信息列表 |  |
| `data.items[].validity_start` | String | 是 | 发证日期 |  |
| `data.items[].category` | String | 是 | 食品类别 |  |
| `data.items[].address` | String | 是 | 住所 |  |
| `data.items[].administration` | String | 是 | 日常监督管理机构 |  |
| `data.items[].url` | String | 是 | 原文链接 | 🔗 |
| `data.items[].updated_time` | String | 是 | 更新时间 |  |
| `data.items[].validity_end` | String | 是 | 有效期至 |  |
| `data.items[].created_time` | String | 是 | 创建时间 |  |
| `data.items[].lic_no` | String | 是 | 证书编号 |  |
| `data.items[].issue_org` | String | 是 | 发证机关 |  |
| `data.items[].prod_address` | String | 是 | 生产地址 |  |
| `data.items[].administrator` | String | 是 | 日常监督管理人员 |  |
| `data.items[].detail.item_list` | Array | 是 | 许可明细-类别信息 |  |
| `data.items[].oper_name` | String | 是 | 法定代表人/负责人 |  |
| `data.items[].credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.items[].detail` | Array | 是 | 许可明细 |  |
| `data.items[].detail[].item_list` | String | 是 | 许可明细 - 类别信息 |  |
| `data.items[].detail[].item_list.category` | String | 是 | 许可明细 - 食品、食品添加剂类别 |  |
| `data.items[].detail[].item_list.category_no` | String | 是 | 许可明细 - 类别编号 |  |
| `data.items[].detail[].item_list.category_name` | String | 是 | 许可明细 - 类别名称 |  |
| `data.items[].detail[].item_list.category_detail` | String | 是 | 许可明细 - 品种明细 |  |
| `data.items[].detail[].item_list.remark` | String | 是 | 许可明细 - 备注 |  |
| `data.items[].detail[].item_list.warehouse` | String | 是 | 许可明细 - 外设仓库地址 |  |
| `data.items[].producer` | String | 是 | 生产者 |  |
| `data.items[].signer` | String | 是 | 签发人 |  |
| `data.items[].type` | String | 是 | 证书类型 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 22.4 食品生产许可证QS

- Hub：`POST /api/v1/data/enterprise/22.4/query`；上游方法 GET；可调用
- 说明：企业食品生产许可证QS信息，包括证件类型、发证机关、检验方式等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 食品生产许可证QS信息列表 |  |
| `data.items[].lic_no` | String | 是 | 证书编号 |  |
| `data.items[].issue_org` | String | 是 | 发证机关 |  |
| `data.items[].prod_address` | String | 是 | 生产地址 |  |
| `data.items[].updated_time` | String | 是 | 更新时间 |  |
| `data.items[].check_type` | String | 是 | 检验方式 |  |
| `data.items[].created_time` | String | 是 | 创建时间 |  |
| `data.items[].address` | String | 是 | 住所 |  |
| `data.items[].producer` | String | 是 | 企业名称 |  |
| `data.items[].type` | String | 是 | 证书类型 |  |
| `data.items[].url` | String | 是 | 原文链接 | 🔗 |
| `data.items[].production` | String | 是 | 产品名称 |  |
| `data.items[].validity_start` | String | 是 | 发证日期 |  |
| `data.items[].validity_end` | String | 是 | 有效期至 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 22.5 食品添加剂生产许可证

- Hub：`POST /api/v1/data/enterprise/22.5/query`；上游方法 GET；可调用
- 说明：企业食品添加剂生产许可证信息，包括证书类型、上报部门、明细等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 食品添加剂许可信息列表 |  |
| `data.items[].province` | String | 是 | 省份 |  |
| `data.items[].remark` | String | 是 | 说明 |  |
| `data.items[].lic_no` | String | 是 | 证书编号 |  |
| `data.items[].issue_org` | String | 是 | 上报部门 |  |
| `data.items[].prod_address` | String | 是 | 生产地址 |  |
| `data.items[].updated_time` | String | 是 | 更新时间 |  |
| `data.items[].created_time` | String | 是 | 创建时间 |  |
| `data.items[].production` | String | 是 | 产品名称 |  |
| `data.items[].address` | String | 是 | 住所 |  |
| `data.items[].detail` | String | 是 | 明细 |  |
| `data.items[].type` | String | 是 | 证书类型 |  |
| `data.items[].url` | String | 是 | 原文链接 | 🔗 |
| `data.items[].producer` | String | 是 | 企业名称 |  |
| `data.items[].validity_start` | String | 是 | 发证日期 |  |
| `data.items[].validity_end` | String | 是 | 有效期至 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 51.71 国际专利列表

- Hub：`POST /api/v1/data/enterprise/51.71/query`；上游方法 GET；可调用
- 说明：查询企业的专利列表相关信息，如公开号、申请号、申请人、专利权人、发明人、代理机构等。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 国际专利列表 |  |
| `data.items[].eid` | string | 是 | 企业id |  |
| `data.items[].ename` | string | 是 | 企业名称 |  |
| `data.items[].role` | string | 是 | 企业角色 |  |
| `data.items[].pub_num` | string | 是 | 公开(公告)号 |  |
| `data.items[].pub_date` | string | 是 | 公开(公告)日 |  |
| `data.items[].first_pub_date` | string | 是 | 首次公开日 |  |
| `data.items[].application_num` | string | 是 | 申请号 |  |
| `data.items[].application_date` | string | 是 | 申请日 |  |
| `data.items[].earliest_priority_date` | string | 是 | 最早优先权日 |  |
| `data.items[].priority_data` | array | 是 | 优先权数据 |  |
| `data.items[].priority_data[].priority_num` | string | 是 | 优先权号码 |  |
| `data.items[].priority_data[].priority_date` | string | 是 | 优先权日期 |  |
| `data.items[].priority_data[].pcountry` | string | 是 | 国家 |  |
| `data.items[].priority_data[].grant_date` | string | 是 | 优先权生成日期 |  |
| `data.items[].pct_pub_num` | string | 是 | PCT公开号 |  |
| `data.items[].pct_pub_date` | string | 是 | PCT公开日 |  |
| `data.items[].pct_application_num` | string | 是 | PCT申请号 |  |
| `data.items[].pct_application_date` | string | 是 | PCT申请日 |  |
| `data.items[].pct_country` | string | 是 | PCT国别 |  |
| `data.items[].gran` | array | 是 | 授权信息 |  |
| `data.items[].gran[].grant_date` | string | 是 | 授权日期 |  |
| `data.items[].gran[].grant_number` | string | 是 | 授权号 |  |
| `data.items[].applicant` | array | 是 | 申请人 |  |
| `data.items[].applicant[].name` | string | 是 | 名称 |  |
| `data.items[].applicant[].address` | string | 是 | 地址 |  |
| `data.items[].applicant[].country` | string | 是 | 国家 |  |
| `data.items[].patentee` | array | 是 | 专利权人 |  |
| `data.items[].patentee[].name` | string | 是 | 名称 |  |
| `data.items[].patentee[].address` | string | 是 | 地址 |  |
| `data.items[].patentee[].country` | string | 是 | 国家 |  |
| `data.items[].inventor` | string | 是 | 发明人 |  |
| `data.items[].agent` | string | 是 | 代理人 |  |
| `data.items[].agency` | array | 是 | 代理机构 |  |
| `data.items[].agency[].name` | string | 是 | 名称 |  |
| `data.items[].related_companies` | array | 是 | 关联企业 |  |
| `data.items[].related_companies[].type` | string | 是 | 类型 |  |
| `data.items[].related_companies[].role` | string | 是 | 角色 |  |
| `data.items[].related_companies[].name` | string | 是 | 企业名称 |  |
| `data.items[].related_companies[].eid` | string | 是 | 企业id |  |
| `data.items[].is_history` | string | 是 | 是否历史 |  |

### 15.44 国际专利详情

- Hub：`POST /api/v1/data/enterprise/15.44/query`；上游方法 GET；可调用
- 说明：详细的国际专利数据，包括公开号、申请号、申请人、发明人、专利类型、分类号等信息。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pub_num` | String | 是 | 公开(公告)号 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.title` | String | 是 | 标题 |  |
| `data.pub_num` | String | 是 | 公开(公告)号 |  |
| `data.pub_date` | String | 是 | 公开(公告)日 |  |
| `data.first_pub_date` | String | 是 | 首次公开日 |  |
| `data.application_num` | String | 是 | 申请号 |  |
| `data.application_date` | String | 是 | 申请日 |  |
| `data.earliest_priority_date` | String | 是 | 最早优先权日 |  |
| `data.priority_data` | array | 是 | 优先权数据 |  |
| `data.priority_data[].priority_num` | string | 是 | 优先权号码 |  |
| `data.priority_data[].priority_date` | string | 是 | 优先权日期 |  |
| `data.priority_data[].pcountry` | string | 是 | 国家 |  |
| `data.priority_data[].grant_date` | string | 是 | 优先权生成日期 |  |
| `data.pct_pub_num` | String | 是 | PCT公开号 |  |
| `data.pct_pub_date` | String | 是 | PCT公开日 |  |
| `data.pct_application_num` | String | 是 | PCT申请号 |  |
| `data.pct_application_date` | String | 是 | PCT申请日 |  |
| `data.pct_country` | String | 是 | PCT国别 |  |
| `data.gran` | array | 是 | 授权信息 |  |
| `data.gran[].grant_date` | string | 是 | 授权日期 |  |
| `data.gran[].grant_number` | string | 是 | 授权号 |  |
| `data.abstract` | String | 是 | 摘要 |  |
| `data.figure` | array | 是 | 摘要附图 |  |
| `data.figure[].url` | string | 是 | url链接 | 🔗 |
| `data.patent_type` | String | 是 | 专利类型 |  |
| `data.patent_literature_type` | String | 是 | 专利文献类型 |  |
| `data.applicant` | array | 是 | 申请人 |  |
| `data.applicant[].name` | string | 是 | 名称 |  |
| `data.applicant[].address` | string | 是 | 地址 |  |
| `data.applicant[].country` | string | 是 | 国家 |  |
| `data.patentee` | array | 是 | 专利权人 |  |
| `data.patentee[].name` | string | 是 | 名称 |  |
| `data.patentee[].address` | string | 是 | 地址 |  |
| `data.patentee[].country` | string | 是 | 国家 |  |
| `data.inventor` | String | 是 | 发明人 |  |
| `data.agent` | String | 是 | 代理人 |  |
| `data.agency` | String | 是 | 代理机构 |  |
| `data.agency.name` | string | 是 | 名称 |  |
| `data.patent_examiner` | String | 是 | 专利审查员 |  |
| `data.assistant_examiner` | String | 是 | 助理审查员 |  |
| `data.patent_searcher` | String | 是 | 专利检索员 |  |
| `data.ipc_classification` | String | 是 | IPC分类号 |  |
| `data.main_ipc_classification` | String | 是 | IPC主分类号 |  |
| `data.cpc_classification` | String | 是 | CPC分类号 |  |
| `data.main_cpc_classification` | String | 是 | CPC主分类号 |  |
| `data.loc_classification` | String | 是 | LOC分类号 |  |
| `data.main_loc_classification` | String | 是 | LOC主分类号 |  |
| `data.fi_classification` | String | 是 | FI分类号 |  |
| `data.ft_classification` | String | 是 | FT分类号 |  |
| `data.us_classification` | String | 是 | 美国专利分类号 |  |
| `data.national_classification` | String | 是 | 国民经济行业分类号 |  |
| `data.strategic_classification` | String | 是 | 战略性新兴产业分类号 |  |
| `data.digital_classification` | String | 是 | 数字经济核心产业分类号 |  |
| `data.simple_legal_status` | String | 是 | 简单法律状态 |  |
| `data.related_companies` | array | 是 | 关联企业 |  |
| `data.related_companies[].type` | string | 是 | 类型 |  |
| `data.related_companies[].role` | string | 是 | 角色 |  |
| `data.related_companies[].name` | string | 是 | 企业名称 |  |
| `data.related_companies[].eid` | string | 是 | 企业id |  |
| `data.is_history` | String | 是 | 是否历史 |  |

## 关联关系


### 41.1 企业链图

- Hub：`POST /api/v1/data/enterprise/41.1/query`；上游方法 GET；可调用
- 说明：企业的股东、高管、对外投资、裁判文书、法院公告、历史股东、投资任职关系关联方（相同股东（含历史）、董监高（含历史）、法定代表人），疑似关系关联方（相同软件著作权、专利、裁判文书、邮箱、域名信息、联系电话（工商）、地址、字号）

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 公司全名 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.info` | Object | 是 | 企业信息 |  |
| `data.info.id` | String | 是 | 企业ID |  |
| `data.info.reg_no` | String | 是 | 企业注册号 |  |
| `data.info.credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.info.org_no` | String | 是 | 组织机构代码 |  |
| `data.info.name` | String | 是 | 企业名称 |  |
| `data.info.oper_name` | String | 是 | 法人 |  |
| `data.info.start_date` | String | 是 | 成立日期 |  |
| `data.info.status` | String | 是 | 企业状态 |  |
| `data.info.short_name` | String | 是 | 企业简称 |  |
| `data.info.address` | String | 是 | 注册地址 |  |
| `data.info.telephone` | String | 是 | 电话 |  |
| `data.info.reg_capi` | String | 是 | 注册资本 |  |
| `data.info.capi_unit` | String | 是 | 注册资本货币单位 |  |
| `data.info.domain` | String | 是 | 行业 |  |
| `data.info.has_problem` | String | 是 | 是否失信 |  |
| `data.node_info` | Object | 是 | 节点信息 |  |
| `data.node_info.partners` | Array | 是 | 股东信息 |  |
| `data.node_info.partners[].id` | String | 是 | 股东Id，个人股东为空 |  |
| `data.node_info.partners[].name` | String | 是 | 名称 |  |
| `data.node_info.partners[].short_name` | String | 是 | 简称 |  |
| `data.node_info.partners[].percent` | String | 是 | 持股比例 |  |
| `data.node_info.employees` | Array | 是 | 主要人员信息 |  |
| `data.node_info.employees[].name` | String | 是 | 主要人员姓名 |  |
| `data.node_info.employees[].title` | String | 是 | 职位 |  |
| `data.node_info.investments` | Array | 是 | 对外投资信息 |  |
| `data.node_info.investments[].id` | String | 是 | 对外投资企业Id |  |
| `data.node_info.investments[].name` | String | 是 | 企业名称 |  |
| `data.node_info.investments[].short_name` | String | 是 | 简称 |  |
| `data.node_info.investments[].percent` | String | 是 | 持股比例 |  |
| `data.node_info.lawsuits` | Array | 是 | 法院判决信息 |  |
| `data.node_info.lawsuits[].name` | String | 是 | 企业名称 |  |
| `data.node_info.lawsuits[].short_name` | String | 是 | 简称 |  |
| `data.node_info.lawsuits[].id` | String | 是 | 法院判决相关企业ID |  |
| `data.node_info.notices` | Array | 是 | 法院公告信息 |  |
| `data.node_info.notices[].id` | String | 是 | 法院公告相关企业ID |  |
| `data.node_info.notices[].name` | String | 是 | 企业名称 |  |
| `data.node_info.notices[].short_name` | String | 是 | 简称 |  |
| `data.node_info.history_partners` | Array | 是 | 历史股东信息 |  |
| `data.node_info.history_partners[].id` | String | 是 | 历史股东ID，个人股东为空 |  |
| `data.node_info.history_partners[].name` | String | 是 | 名称 |  |
| `data.node_info.history_partners[].short_name` | String | 是 | 简称 |  |
| `data.node_info.suspected_relation` | Array | 是 | 疑似关系企业信息 |  |
| `data.node_info.suspected_relation[].id` | String | 是 | 疑似关系企业ID |  |
| `data.node_info.suspected_relation[].name` | String | 是 | 企业名称 |  |
| `data.node_info.suspected_relation[].short_name` | String | 是 | 简称 |  |
| `data.node_info.suspected_relation[].related_by` | Array | 是 | 疑似关系信息 |  |
| `data.node_info.suspected_relation[].related_by[].type` | String | 是 | 疑似关系类型 |  |
| `data.node_info.suspected_relation[].related_by[].content` | String | 是 | 疑似关系内容 |  |

### 55.5 实际控制人

- Hub：`POST /api/v1/data/enterprise/55.5/query`；上游方法 GET；可调用
- 说明：指企业的实际控制企业或自然人，根据《公司法》第216条的定义，是指虽然不是公司的股东，但通过投资关系、协议或者其他安排，能够实际支配公司行为的人。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，具体字段 含义见下表 |  |
| `data.nodes` | Array | 是 | 节点信息列表 |  |
| `data.nodes[].uid` | String | 是 | 节点实体标识符 |  |
| `data.nodes[].name` | String | 是 | 节点实体名称 |  |
| `data.nodes[].id` | String | 是 | 节点 id |  |
| `data.nodes[].type` | String | 是 | 实体类型, E：企业，P：个人，UE： 未在工商注册的企业,U：类似社会公众 股、自然人股东、法人股等 |  |
| `data.nodes[].creditNo` | String | 是 | 统一社会信用代码 |  |
| `data.nodes[].isKey` | String | 是 | 标识是否是疑似实际控制人节点或者查 询企业节点 |  |
| `data.links` | Array | 是 | 路径信息列表 |  |
| `data.links[].sourceId` | Number | 是 | 路径开始节点 id |  |
| `data.links[].targetId` | Number | 是 | 路径结束节点 id |  |
| `data.links[].type` | String | 是 | 关系类型 |  |
| `data.links[].properties` | Object | 是 | 关系属性 |  |
| `data.links[].properties.relationPercent` | String | 是 | 控股比例 |  |
| `data.links[].properties.relationAmount` | String | 是 | 控股金额 |  |
| `data.links[].properties.relationPercentSuspected` | String | 是 | 疑似控股比例 |  |
| `data.links[].properties.relationDescDetail` | String | 是 | 关系类型描述 |  |
| `data.links[].properties.relationLrDescDetail` | String | 是 | 控制关系描述（执行事务合伙人） |  |
| `data.links[].properties.isMainPath` | String | 是 | 控制路径，1 为控制路径，非控制路径为0 |  |
| `data.creditNo` | String | 是 | 被查询企业的统一社会信用代码 |  |
| `data.totalPercent` | Number | 是 | 疑似实际控制人的控股比 |  |
| `data.entityName` | String | 是 | 实控人名称 |  |
| `data.entityId` | String | 是 | 实际控制人id |  |

### 77.76 参股控股企业

- Hub：`POST /api/v1/data/enterprise/77.76/query`；上游方法 GET；可调用
- 说明：根据企业名称获取参股控股企业信息，包括被投资企业状态、总投资比例、直接投资比例等信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |
| `pname` | String | 否 | 人员姓名，人员与企业须存在法人或者股东或者董监高的关系 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].name` | String | 是 | 名称 |  |
| `data.items[].invest_name` | String | 是 | 被投资企业名称 |  |
| `data.items[].invest_credit_no` | String | 是 | 被投资企业统一社会信用代码 |  |
| `data.items[].invest_status` | String | 是 | 被投资企业状态 |  |
| `data.items[].invest_percent` | String | 是 | 总投资比例 |  |
| `data.items[].path` | String | 是 | 投资路径 |  |
| `data.items[].direct_percent` | String | 是 | 直接投资比例 |  |
| `data.items[].invest_level` | String | 是 | 最短投资层级 |  |
| `data.items[].invest_desc` | String | 是 | 投资描述 |  |
| `data.items[].invest_relationship_path` | Array | 是 | 投资路径 |  |
| `data.items[].his_direct_invest` | String | 是 | 是否历史直接投资（0否1是） |  |
| `data.items[].end_date` | String | 是 | 历史投资退出日期 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 33.13 实际控制企业

- Hub：`POST /api/v1/data/enterprise/33.13/query`；上游方法 GET；可调用
- 说明：实际控制企业信息，有相同实际控制人的企业信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 实际控制企业数量 |  |
| `data.items` | Array | 是 | 实际控制企业列表 |  |
| `data.items[].percent` | Number | 是 | 控股比例 |  |
| `data.items[].pname` | String | 是 | 投资方 |  |
| `data.items[].eid` | String | 是 | 投资企业ID |  |
| `data.items[].ename` | String | 是 | 投资企业名称 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 44.2 股权穿透（三层股东）

- Hub：`POST /api/v1/data/enterprise/44.2/query`；上游方法 GET；可调用
- 说明：企业的三层股权穿透，三层股东（向上）穿透详细信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.actual_controller` | Object | 是 | 实际控制人信息 |  |
| `data.actual_controller.name` | String | 是 | 实际控制人姓名 |  |
| `data.actual_controller.percent` | String | 是 | 实际控制人股比 |  |
| `data.equity_structure` | Object | 是 | 股权结构信息 |  |
| `data.equity_structure.eid` | String | 是 | 企业ID |  |
| `data.equity_structure.name` | String | 是 | 企业名称 |  |
| `data.equity_structure.short_name` | String | 是 | 企业简称 |  |
| `data.equity_structure.count` | Number | 是 | 对应的children数量 |  |
| `data.equity_structure.level` | String | 是 | 层级 |  |
| `data.equity_structure.children` | Array | 是 | 股权穿透次级信息 |  |
| `data.equity_structure.children[].eid` | String | 是 | 股东ID |  |
| `data.equity_structure.children[].name` | String | 是 | 股东名称 |  |
| `data.equity_structure.children[].type` | String | 是 | 股东类型，（E 企业 P 个人 UE 未在工商注册的公司 U 其他） |  |
| `data.equity_structure.children[].short_name` | String | 是 | 股东简称 |  |
| `data.equity_structure.children[].amount` | String | 是 | 股东出资金额 |  |
| `data.equity_structure.children[].percent` | String | 是 | 股东比例 |  |
| `data.equity_structure.children[].sh_type` | String | 是 | 股东类型，工商股东/十大股东/主要股东(新三板)/原工商股东 |  |
| `data.equity_structure.children[].level` | String | 是 | 层级 |  |
| `data.equity_structure.children[].count` | Number | 是 | 对应的children数量 |  |
| `data.equity_structure.children[].children` | Array | 是 | 参考children字段 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 55.2 股权穿透（十层股东）

- Hub：`POST /api/v1/data/enterprise/55.2/query`；上游方法 GET；可调用
- 说明：企业的十层股权穿透，十层股东（向上）穿透的详细信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全称 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.child_statics` | Array | 是 | 股东层级数量统计 |  |
| `data.child_statics[].level_text` | String | 是 | 股东层级 |  |
| `data.child_statics[].count` | Number | 是 | 数量 |  |
| `data.econ_kinds` | Array | 是 | 企业类型 |  |
| `data.econ_kinds[].name` | String | 是 | 类型 |  |
| `data.econ_kinds[].count` | Number | 是 | 数量 |  |
| `data.stock_holder_five` | Array | 是 | 股东信息（五级）返回数据字段与一级一致 |  |
| `data.stock_holder_four` | Array | 是 | 股东信息（四级）返回数据字段与一级一致 |  |
| `data.stock_holder_one` | Array | 是 | 股东信息（一级） |  |
| `data.stock_holder_one[].name` | String | 是 | 企业名称 |  |
| `data.stock_holder_one[].invest_path` | String | 是 | 投资路径 |  |
| `data.stock_holder_one[].ent_type` | String | 是 | 企业类型 |  |
| `data.stock_holder_one[].summary_text` | String | 是 | 风险情况 |  |
| `data.stock_holder_one[].stock_holder` | Array | 是 | 股东信息 |  |
| `data.stock_holder_one[].stock_holder[].name` | String | 是 | 股东名称 |  |
| `data.stock_holder_one[].stock_holder[].stock_type` | String | 是 | 股东类型 |  |
| `data.stock_holder_one[].stock_holder[].unit` | String | 是 | 认缴出资单位 |  |
| `data.stock_holder_one[].stock_holder[].amount` | String | 是 | 认缴出资额 |  |
| `data.stock_holder_one[].stock_holder[].invest_type` | String | 是 | 出资类型 |  |
| `data.stock_holder_one[].stock_holder[].percent` | String | 是 | 持股比例 |  |
| `data.stock_holder_eight` | Array | 是 | 股东信息（八级）返回数据字段与一级一致 |  |
| `data.stock_holder_three` | Array | 是 | 股东信息（三级）返回数据字段与一级一致 |  |
| `data.actual_invest_path` | String | 是 | 疑似控制路径 |  |
| `data.stock_holder_nine` | Array | 是 | 股东信息（九级）返回数据字段与一级一致 |  |
| `data.enterprise` | Object | 是 | 工商基本信息 |  |
| `data.enterprise.id` | String | 是 | 企业id |  |
| `data.enterprise.name` | String | 是 | 企业名称 |  |
| `data.enterprise.econ_kind` | String | 是 | 企业类型 |  |
| `data.enterprise.regist_capi` | String | 是 | 注册资本 |  |
| `data.enterprise.address` | String | 是 | 地址 |  |
| `data.enterprise.reg_no` | String | 是 | 企业注册号 |  |
| `data.enterprise.scope` | String | 是 | 经营范围 |  |
| `data.enterprise.business_term` | String | 是 | 营业期限 |  |
| `data.enterprise.belong_org` | String | 是 | 登记机关 |  |
| `data.enterprise.oper_name` | String | 是 | 企业法定代表人 |  |
| `data.enterprise.start_date` | String | 是 | 成立日期 |  |
| `data.enterprise.credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.enterprise.org_no` | String | 是 | 组织机构代码 |  |
| `data.enterprise.status` | String | 是 | 经营状态 |  |
| `data.enterprise.check_date` | String | 是 | 发照日期 |  |
| `data.stock_holder_ten` | Array | 是 | 股东信息（十级）返回数据字段与一级一致 |  |
| `data.stock_holder_six` | Array | 是 | 股东信息（六级）返回数据字段与一级一致 |  |
| `data.stock_holder_two` | Array | 是 | 股东信息（二级）返回数据字段与一级一致 |  |
| `data.stock_holder_seven` | Array | 是 | 股东信息（七级）返回数据字段与一级一致 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 33.15 股权穿透信息（股东穿透）

- Hub：`POST /api/v1/data/enterprise/33.15/query`；上游方法 GET；可调用
- 说明：企业的不限股比股权穿透（向上股东穿透），不限股比但是穿透到自然人、上市公司、社会组织、政府机构和学校、医院、海外公司、基金会、事业单位和律所会停止穿透

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.children` | Array | 是 | 股权次级结构信息 |  |
| `data.children[].type` | String | 是 | 股东类型（E企业、P个人、SP特殊企业、LT上市公司、S社会组织、U其他、UE未在工商注册的企业或者组织、G政府） |  |
| `data.children[].count` | Number | 是 | 对应的children数量 |  |
| `data.children[].eid` | String | 是 | 股东ID |  |
| `data.children[].name` | String | 是 | 股东名称 |  |
| `data.children[].percent` | String | 是 | 比例 |  |
| `data.children[].repeat` | String | 是 | 无实际含义 |  |
| `data.children[].level` | Number | 是 | 层级 |  |
| `data.children[].children` | Array | 是 | 参考children字段 |  |
| `data.children[].children[].eid` | String | 是 | 股东ID |  |
| `data.children[].children[].name` | String | 是 | 股东名称 |  |
| `data.children[].children[].type` | String | 是 | 股东类型（E企业、P个人、SP特殊企业、LT上市公司、S社会组织、U其他、UE未在工商注册的企业或者组织、G政府） |  |
| `data.children[].children[].percent` | String | 是 | 比例 |  |
| `data.children[].children[].repeat` | String | 是 | 无实际含义 |  |
| `data.children[].children[].level` | Number | 是 | 层级 |  |
| `data.children[].children[].count` | Number | 是 | 对应的children数量 |  |
| `data.level` | Number | 是 | 层级 |  |
| `data.name` | String | 是 | 企业名称 |  |
| `data.percent` | String | 是 | 比例 |  |
| `data.eid` | String | 是 | 企业ID |  |
| `data.repeat` | String | 是 | 无实际含义 |  |
| `data.count` | Number | 是 | 对应的children数量 |  |
| `data.type` | String | 是 | 股东类型（E企业、P个人、SP特殊企业、LT上市公司、S社会组织、U其他、UE未在工商注册的企业或者组织、G政府） |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 2.53 企业族谱穿透信息

- Hub：`POST /api/v1/data/enterprise/2.53/query`；上游方法 GET；可调用
- 说明：企业的十二层股权穿透，包括六层对外投资（向下）和六层股东（向上）穿透详细信息，并可自定义穿透持股比例和层级，并且支持返回Excel可视化报告

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `direction` | Number | 是 | 股权穿透类型：1-股东股权穿透，2-对外投资穿透 |
| `level` | Number | 否 | 穿透层级，1-6（默认为3） |
| `totpercent` | Number | 否 | 企业股权占比最小值，0-1（默认为0.05，当传入0的时候，为不限股比返回所有的数据，包含股比为空值的情况，其他指定值无法返回股比为空值的情况） |
| `form` | Number | 否 | 输出格式，0为Json，1为excel（默认为0） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.name` | String | 是 | 企业名称 |  |
| `data.type` | String | 是 | 穿透类型，1-股东股权穿透，2-对外投资穿透 |  |
| `data.equity_path` | Array | 是 | 持股路径，当请求入参form=0时，返回该字段 |  |
| `data.equity_path[].entity_eid` | String | 是 | 企业id |  |
| `data.equity_path[].entity_name` | String | 是 | 企业名称 |  |
| `data.equity_path[].credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.equity_path[].status` | String | 是 | 企业状态 |  |
| `data.equity_path[].total_equity_percent` | String | 是 | 总持股比例 |  |
| `data.equity_path[].equity_compute_process` | String | 是 | 计算过程 |  |
| `data.equity_path[].single_equity_path_list` | Array | 是 | 单条持股路径列表 |  |
| `data.equity_path[].single_equity_path_list[].level` | String | 是 | 层级 |  |
| `data.equity_path[].single_equity_path_list[].type` | String | 是 | 持股方式，枚举：直接、间接 |  |
| `data.equity_path[].single_equity_path_list[].should_capi` | String | 是 | 认缴出资 |  |
| `data.equity_path[].single_equity_path_list[].equity_percent` | String | 是 | 单条路径总持股 |  |
| `data.equity_path[].single_equity_path_list[].level1_entity_eid` | String | 是 | 公司1id |  |
| `data.equity_path[].single_equity_path_list[].level1_entity_name` | String | 是 | 公司1名称 |  |
| `data.equity_path[].single_equity_path_list[].level1_percent` | String | 是 | 股比1 |  |
| `data.equity_path[].single_equity_path_list[].level2_entity_eid` | String | 是 | 公司2id |  |
| `data.equity_path[].single_equity_path_list[].level2_entity_name` | String | 是 | 公司2名称 |  |
| `data.equity_path[].single_equity_path_list[].level2_percent` | String | 是 | 股比2 |  |
| `data.equity_path[].single_equity_path_list[].level3_entity_eid` | String | 是 | 公司3id |  |
| `data.equity_path[].single_equity_path_list[].level3_entity_name` | String | 是 | 公司3名称 |  |
| `data.equity_path[].single_equity_path_list[].level3_percent` | String | 是 | 股比3 |  |
| `data.equity_path[].single_equity_path_list[].level4_entity_eid` | String | 是 | 公司4id |  |
| `data.equity_path[].single_equity_path_list[].level4_entity_name` | String | 是 | 公司4名称 |  |
| `data.equity_path[].single_equity_path_list[].level4_percent` | String | 是 | 股比4 |  |
| `data.equity_path[].single_equity_path_list[].level5_entity_eid` | String | 是 | 公司5id |  |
| `data.equity_path[].single_equity_path_list[].level5_entity_name` | String | 是 | 公司5名称 |  |
| `data.equity_path[].single_equity_path_list[].level5_percent` | String | 是 | 股比5 |  |
| `data.equity_path[].single_equity_path_list[].level6_entity_eid` | String | 是 | 公司6id |  |
| `data.equity_path[].single_equity_path_list[].level6_entity_name` | String | 是 | 公司6名称 |  |
| `data.equity_path[].single_equity_path_list[].level6_percent` | String | 是 | 股比6 |  |
| `data.equity_path[].single_equity_path_list[].level7_entity_eid` | String | 是 | 公司7id |  |
| `data.equity_path[].single_equity_path_list[].level7_entity_name` | String | 是 | 公司7名称 |  |
| `data.doc_path` | String | 是 | 文件下载路径，当入参form=1时返回该字段 | 🔗 |

### 28.1 三层族谱

- Hub：`POST /api/v1/data/enterprise/28.1/query`；上游方法 GET；可调用
- 说明：企业的六层股权穿透，包括三层对外投资（向下）和三层股东（向上）穿透详细信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.p_trees` | Array | 是 | 股东族谱 |  |
| `data.p_trees[].eid` | String | 是 | 企业id，只有工商注册的企业不为空，其它都为空 |  |
| `data.p_trees[].name` | String | 是 | 姓名 |  |
| `data.p_trees[].type` | String | 是 | 类型，“E”表示企业，“P”表示个人，UE-未在工商注册的企业 U-类似社会公众股、自然人股东、法人股等字段 |  |
| `data.p_trees[].has_problem` | String | 是 | 是否有失信记录，“0”表示没有，“1”表示有 |  |
| `data.p_trees[].short_name` | String | 是 | 姓名 |  |
| `data.p_trees[].amount` | String | 是 | 投资金额(万元) |  |
| `data.p_trees[].percent` | String | 是 | 占股比 |  |
| `data.p_trees[].sh_type` | String | 是 | 股东类型 |  |
| `data.p_trees[].level` | String | 是 | 股东层级 |  |
| `data.p_trees[].identifier` | String | 是 | 节点唯一标识，用于构图 |  |
| `data.p_trees[].items` | Array | 是 | 当前结点的股东族谱，子节点结构与父节点相同，包含字段eid，name，type，has_problem，short_name，identifier，items |  |
| `data.c_count` | Number | 是 | 对外投资族谱的子节点个数 |  |
| `data.p_count` | Number | 是 | 股东族谱的子节点个数 |  |
| `data.name` | String | 是 | 名称 |  |
| `data.has_problem` | String | 是 | 是否有失信记录，&ldquo;0&rdquo;表示没有，&ldquo;1&rdquo;表示有 |  |
| `data.eid` | String | 是 | 企业id，只有工商注册的企业不为空，其它都为空 |  |
| `data.c_trees` | Array | 是 | 对外投资族谱 |  |
| `data.c_trees[].eid` | String | 是 | 企业id，只有工商注册的企业不为空，其它都为空 |  |
| `data.c_trees[].name` | String | 是 | 名称 |  |
| `data.c_trees[].type` | String | 是 | 类型，“E”表示企业，“P”表示个人，UE-未在工商注册的企业 U-类似社会公众股、自然人股东、法人股等字段 |  |
| `data.c_trees[].has_problem` | String | 是 | 是否有失信记录，“0”表示没有，“1”表示有 |  |
| `data.c_trees[].short_name` | String | 是 | 名称简称 |  |
| `data.c_trees[].amount` | String | 是 | 投资金额(万元) |  |
| `data.c_trees[].percent` | String | 是 | 占股比 |  |
| `data.c_trees[].sh_type` | String | 是 | 股东类型 |  |
| `data.c_trees[].level` | String | 是 | 股东层级 |  |
| `data.c_trees[].identifier` | String | 是 | 节点唯一标识，用于构图 |  |
| `data.c_trees[].items` | Array | 是 | 当前结点的对外投资族谱，子节点结构与父节点相同，包含字段eid，name，type，has_problem，short_name，identifier，items |  |
| `data.identifier` | String | 是 | 节点唯一标识，用于构图 |  |
| `data.type` | String | 是 | 类型，&ldquo;E&rdquo;表示企业，&ldquo;P&rdquo;表示个人，UE-未在工商注册的企业U-类似社会公众股、自然人股东、法人股等字段 |  |
| `data.short_name` | String | 是 | 名称简称 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 28.3 六层族谱

- Hub：`POST /api/v1/data/enterprise/28.3/query`；上游方法 GET；可调用
- 说明：企业的十二层股权穿透，包括六层对外投资（向下）和六层股东（向上）穿透详细信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.type` | String | 是 | 类型，&ldquo;E&rdquo;表示企业，&ldquo;P&rdquo;表示个人，UE-未在工商注册的企业U-类似社会公众股、自然人股东、法人股等字段 |  |
| `data.short_name` | String | 是 | 名称简称 |  |
| `data.has_problem` | String | 是 | 是否有失信记录，&ldquo;0&rdquo;表示没有，&ldquo;1&rdquo;表示有 |  |
| `data.c_count` | Number | 是 | 对外投资族谱的子节点个数 |  |
| `data.p_count` | Number | 是 | 股东族谱的子节点个数 |  |
| `data.name` | String | 是 | 名称 |  |
| `data.p_trees` | Array | 是 | 股东族谱 |  |
| `data.p_trees[].eid` | String | 是 | 企业 id，只有工商注册的企业不为空，其 它都为空 |  |
| `data.p_trees[].name` | String | 是 | 姓名 |  |
| `data.p_trees[].type` | String | 是 | 类型，“E”表示企业，“P”表示个人， UE-未在工商注册的企业 U-类似社会公 众股、自然人股东、法人股等字段 |  |
| `data.p_trees[].has_problem` | String | 是 | 是否有失信记录，“0”表示没有，“1” 表示有 |  |
| `data.p_trees[].short_name` | String | 是 | 姓名 |  |
| `data.p_trees[].amount` | String | 是 | 投资金额(万元) |  |
| `data.p_trees[].percent` | String | 是 | 占股比 |  |
| `data.p_trees[].sh_type` | String | 是 | 股东类型 |  |
| `data.p_trees[].level` | String | 是 | 股东层级 |  |
| `data.p_trees[].identifier` | String | 是 | 节点唯一标识，用于构图 |  |
| `data.p_trees[].items` | Array | 是 | 当前结点的股东族谱，子节点结构与父节 点相同，包含字段 eid，name，type， has_problem，short_name，identifier， items |  |
| `data.eid` | String | 是 | 企业id，只有工商注册的企业不为空，其它都为空 |  |
| `data.c_trees` | Array | 是 | 对外投资族谱 |  |
| `data.c_trees[].eid` | String | 是 | 企业 id，只有工商注册的企业不为空，其 它都为空 |  |
| `data.c_trees[].name` | String | 是 | 名称 |  |
| `data.c_trees[].type` | String | 是 | 类型，“E”表示企业，“P”表示个人， UE-未在工商注册的企业 U-类似社会公 5 众股、自然人股东、法人股等字段 |  |
| `data.c_trees[].has_problem` | String | 是 | 是否有失信记录，“0”表示没有，“1” 表示有 |  |
| `data.c_trees[].short_name` | String | 是 | 名称简称 |  |
| `data.c_trees[].amount` | String | 是 | 投资金额(万元) |  |
| `data.c_trees[].percent` | String | 是 | 占股比 |  |
| `data.c_trees[].sh_type` | String | 是 | 股东类型 |  |
| `data.c_trees[].level` | String | 是 | 股东层级 |  |
| `data.c_trees[].identifier` | String | 是 | 节点唯一标识，用于构图 |  |
| `data.c_trees[].items` | Array | 是 | 当前结点的对外投资族谱，子节点结构与 父节点相同，包含字段 eid，name，type， has_problem，short_name，identifier， items |  |
| `data.identifier` | String | 是 | 节点唯一标识，用于构图 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 33.12 关联企业

- Hub：`POST /api/v1/data/enterprise/33.12/query`；上游方法 GET；可调用
- 说明：关联企业相关信息，入参企业上下两层穿透，包括法人、股东、对外投资、董监高等关系类型

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `relationship_type` | String | 否 | 关系类型，默认全部返回.枚举：股东、历史股东、董监高、法人、历史董监高、历史法人。多个输入用,隔开 |
| `relationship_level` | String | 否 | 关联层级,默认2 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.links` | Array | 是 | 关联关系中路径信息列表 |  |
| `data.links[].sourceId` | Number | 是 | 路径源 id |  |
| `data.links[].targetId` | Number | 是 | 路径目标 id |  |
| `data.links[].type` | String | 是 | 关联关系类型 |  |
| `data.links[].properties` | Object | 是 | 疑似持股信息，当 type 为 SH（股东）/ HSH（历史股东） |  |
| `data.links[].properties.relationPercent` | String | 是 | 持股比例，当 type 为 SH（股东）/ HSH（历史股东） |  |
| `data.links[].properties.relationAmount` | String | 是 | 持股数量，当 type 为 SH（股东）/ HSH（历史股东） |  |
| `data.links[].properties.relationPercentSuspected` | String | 是 | 疑似持股比例，当 type 为 SH（股东）/ HSH（历史股东） |  |
| `data.links[].properties.relationDescDetail` | String | 是 | 关联关系类型详细描述，当 type 为 SH（股东）/ HSH（历史股东） |  |
| `data.links[].properties` | Object | 是 | 关联信息，当 type 为 LR（法人）,EXEC(董监高）,HEXEC（历史董监高）,HLR（历史法人） |  |
| `data.links[].properties.relationDescDetail` | String | 是 | 关系描述，当 type 为 LR（法人）,EXEC(董监高）,HEXEC（历史董监高）,HLR（历史法人） |  |
| `data.nodes` | Array | 是 | 关联关系中节点信息列表 |  |
| `data.nodes[].uid` | String | 是 | 企业 eid/自然人 pid |  |
| `data.nodes[].name` | String | 是 | 企业名称/自然人姓名 |  |
| `data.nodes[].credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.nodes[].id` | Number | 是 | 节点 id |  |
| `data.nodes[].type` | String | 是 | 节点类型，E：企业，P：自然人 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 33.9 疑似关联方查询

- Hub：`POST /api/v1/data/enterprise/33.9/query`；上游方法 GET；可调用
- 说明：与目标企业有疑似关系的关联企业（相同软件著作权，专利，裁判文书，邮箱，域名信息，联系电话（工商），地址，字号相同）

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中疑似关系总数 |  |
| `data.items` | Array | 是 | 疑似关系信息列表 |  |
| `data.items[].eid` | String | 是 | 企业 id |  |
| `data.items[].name` | String | 是 | 企业名称 |  |
| `data.items[].credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.items[].relation` | Array | 是 | 疑似关系信息 |  |
| `data.items[].relation[].relation_type` | String | 是 | 疑似关系类型 |  |
| `data.items[].relation[].desc_detail` | String | 是 | 疑似关系类型以及详细说明:same_email 有相同的邮箱； same_phone 有相同的电话号码； same_address 有相同的地址； same_lawsuit 在多份裁判文书中为同一 方；same_patent 共同拥有多份专利 ； same_copyright 共同拥有多份软件著作 权；same_website 有相同的域名； same_website_email_key 域名关键词和邮箱 关键词相同； same_proper_name 有相同的企业字号 |  |

### 45.93 两家企业间关联关系排查

- Hub：`POST /api/v1/data/enterprise/45.93/query`；上游方法 GET；可调用
- 说明：排查两家企业或者人员之间的投资任职等关系，支持关系类型自定义、排查层级自定义，最深可支持15层排查。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keywordone` | String | 是 | 企业全名字/统一社会信用代码字符串或者人员信息字符串；人员信息字符串必须使用企业 A\|人员 A格式，人员与企业有任职投资关系 |
| `keywordtwo` | String | 是 | 企业全名/统一社会信用代码字符串或者人员信息字符串；人员信息字符串必须使用企业 A\|人员 A格式，人员与企业有任职投资关系 |
| `relation` | String | 否 | 参考请求示例，关系类型，不同关系类型用 \| 隔开可根据具体需要选择关系类型， 默认传入直接关系，包括：SH股东、LR法人、EXEC董监高、HSH历史股东、HLR历史法人、HEXEC历史董监高、branch分支机构、以下这些关系根据需求输入：SC供应关系、same_phone相同电话号码、same_address相同地址、same_email相同邮箱、same_website相同域名、same_web_email域名关键字和邮箱关键字相同、same_proper_name 相同企业字号、same_lawsuit相同裁判文书、same_software相同软件著作权、same_patent相同专利、same_history_address相同历史地址、same_history_email 相同的历史邮箱、same_history_phone相同的历史号码 |
| `level` | String | 否 | 查询层数（1-15，默认为6层） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].nodes` | Array | 是 | 关联关系中节点信息列表 |  |
| `data.items[].nodes[].id` | String | 是 | 企业id |  |
| `data.items[].nodes[].name` | String | 是 | 节点名称 |  |
| `data.items[].nodes[].is_key` | String | 是 | 是否为输入的企业或人员 |  |
| `data.items[].nodes[].label` | String | 是 | P个人、E企业、SP特殊企业、LT上市公司、S社会组织、U其他、UE未在工商注册的企业或组织、G政府 |  |
| `data.items[].links` | Array | 是 | 关联关系中路径信息列表 |  |
| `data.items[].links[].start_id` | String | 是 | 关系起节点的id |  |
| `data.items[].links[].end_id` | String | 是 | 关系终节点的id |  |
| `data.items[].links[].relation` | String | 是 | 关联关系描述；SH股东、EXEC董监高（DIR董事、SUP监事、EXE高管）、HEXEC历史董监高（（HDIR董事、HSUP监事、HEXE高管））、LR法人、HSH历史股东、branch分支机构、HLR历史法人、same_phone相同电话号码、same_address相同地址、same_email相同邮箱、same_website相同域名、same_web_email域名关键字和邮箱关键字相同、same_proper_name 相同企业字号、same_lawsuit相同裁判文书、same_software相同软件著作权、same_patent相利、same_history_address相同历史地址、same_history_email 相同的历史邮箱、same_history_phone相同的历史号码 |  |
| `data.items[].links[].detail` | Object | 是 | 关联关系详情 |  |

### 33.10 企业间找关系-JOB申请

- Hub：`POST /api/v1/data/enterprise/33.10/query`；上游方法 GET；可调用
- 说明：企业间找关系（十家），支持最多十家公司间的投资任职关系。异步接口，根据此接口返回的id在“33.11企业间找关系-详细数据”获取结果数据

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `enterprises` | String | 是 | 企业全名字符串, 注意企业名称间用英文逗号分隔。支持最少两家最多十家企业 |
| `persons` | String | 否 | 人员信息字符串, 注意人员间用英文逗号分隔。企业名称和人员姓名用\|分隔 如：企业 A\|人员 A,企业 B\|人员 B和企业共支持最少两家最多十家企业 |
| `relations` | String | 否 | 直接关系类型，默认全部，格式如下SH\|HSH\|EXEC\|HEXEC\|LR\|HLR\|branch； SH股东、EXEC董监高、HEXEC历史董监高、LR法人、HSH历史股东、branch分支机构、HLR历史法人 |
| `level` | String | 否 | 层级，默认6层，1-7层 |
| `containSuspect` | String | 否 | 是否包含疑似关系 1-包含 0-不包含 |
| `suspect_relations` | String | 否 | 疑似关系类型，包含默认全部：same_phone\|same_address\|same_email\|same_history_phone\|same_history_address\|same_history_email\|same_website\|same_web_email\|same_proper_name\|same_patent\|same_software\|same_lawsuit |
| `path` | String | 否 | 关系路径，枚举：0：最短路径；1：全部路径，该接口默认查询最短路径 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.key` | String | 是 | 企业关系的key，用户可调用接口33.11企业间找关系-详细数据来获取job状态（24h内有效） |  |
| `data.params` | Array | 是 |  |  |
| `data.params[].uidList` | Object | 是 | 用户id列表 |  |
| `data.params[].level` | String | 是 | 层级 |  |
| `data.params[].pair_single_tag` | String | 是 | 单对关系标识 |  |
| `data.params[].pair_single_suspect` | String | 是 | 单对疑似关系 |  |
| `data.params[].filter_relation` | String | 是 | 关联关系 |  |
| `data.params[].nodesOne` | Array | 是 | 节点1 |  |
| `data.params[].nodesOne[].eid` | String | 是 | 企业id |  |
| `data.params[].nodesOne[].uid` | String | 是 | 用户id |  |
| `data.params[].nodesOne[].name` | String | 是 | 企业名称 |  |
| `data.params[].nodesOne[].type` | String | 是 | 企业类型 |  |
| `data.params[].nodesTwo` | Array | 是 | 节点2 |  |
| `data.params[].nodesTwo[].eid` | String | 是 | 企业id |  |
| `data.params[].nodesTwo[].uid` | String | 是 | 用户id |  |
| `data.params[].nodesTwo[].name` | String | 是 | 企业名称 |  |
| `data.params[].nodesTwo[].type` | String | 是 | 企业类型 |  |
| `data.params[].nodesThree` | Array | 是 | 节点3 |  |
| `data.params[].nodesThree[].eid` | String | 是 | 企业id |  |
| `data.params[].nodesThree[].uid` | String | 是 | 用户id |  |
| `data.params[].nodesThree[].name` | String | 是 | 企业名称 |  |
| `data.params[].nodesThree[].type` | String | 是 | 企业类型 |  |
| `data.params[].nodesFour` | Array | 是 | 节点4 |  |
| `data.params[].nodesFour[].eid` | String | 是 | 企业id |  |
| `data.params[].nodesFour[].uid` | String | 是 | 用户id |  |
| `data.params[].nodesFour[].name` | String | 是 | 企业名称 |  |
| `data.params[].nodesFour[].type` | String | 是 | 企业类型 |  |
| `data.params[].nodesFive` | Array | 是 | 节点5 |  |
| `data.params[].nodesFive[].eid` | String | 是 | 企业id |  |
| `data.params[].nodesFive[].uid` | String | 是 | 用户id |  |
| `data.params[].nodesFive[].name` | String | 是 | 企业名称 |  |
| `data.params[].nodesFive[].type` | String | 是 | 企业类型 |  |
| `data.params[].nodesSix` | Array | 是 | 节点6 |  |
| `data.params[].nodesSix[].eid` | String | 是 | 企业id |  |
| `data.params[].nodesSix[].uid` | String | 是 | 用户id |  |
| `data.params[].nodesSix[].name` | String | 是 | 企业名称 |  |
| `data.params[].nodesSix[].type` | String | 是 | 企业类型 |  |
| `data.params[].nodesSeven` | Array | 是 | 节点7 |  |
| `data.params[].nodesSeven[].eid` | String | 是 | 企业id |  |
| `data.params[].nodesSeven[].uid` | String | 是 | 用户id |  |
| `data.params[].nodesSeven[].name` | String | 是 | 企业名称 |  |
| `data.params[].nodesSeven[].type` | String | 是 | 企业类型 |  |
| `data.params[].nodesEight` | Array | 是 | 节点8 |  |
| `data.params[].nodesEight[].eid` | String | 是 | 企业id |  |
| `data.params[].nodesEight[].uid` | String | 是 | 用户id |  |
| `data.params[].nodesEight[].name` | String | 是 | 企业名称 |  |
| `data.params[].nodesEight[].type` | String | 是 | 企业类型 |  |
| `data.params[].nodesNine` | Array | 是 | 节点9 |  |
| `data.params[].nodesNine[].eid` | String | 是 | 企业id |  |
| `data.params[].nodesNine[].uid` | String | 是 | 用户id |  |
| `data.params[].nodesNine[].name` | String | 是 | 企业名称 |  |
| `data.params[].nodesNine[].type` | String | 是 | 企业类型 |  |
| `data.params[].nodesTen` | Array | 是 | 节点10 |  |
| `data.params[].nodesTen[].eid` | String | 是 | 企业id |  |
| `data.params[].nodesTen[].uid` | String | 是 | 用户id |  |
| `data.params[].nodesTen[].name` | String | 是 | 企业名称 |  |
| `data.params[].nodesTen[].type` | String | 是 | 企业类型 |  |
| `data.params[].filter_rels_tag` | String | 是 | 关系标识 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 33.11 企业间找关系-详细数据

- Hub：`POST /api/v1/data/enterprise/33.11/query`；上游方法 GET；可调用
- 说明：支持最多十家公司间的投资任职关系

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `key` | String | 是 | 企业找关系的key如&rdquo;fd_rlt_excl_res:ba1418d1-42be-4488-bb13-708251e9f5b6&rdquo; |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.links` | Array | 是 | 关联关系中路径信息列表 |  |
| `data.links[].source_id` | String | 是 | 关系起节点的id，即node.uid |  |
| `data.links[].target_id` | String | 是 | 关系终节点的id，即node.uid |  |
| `data.links[].label` | String | 是 | 企业关系描述，具体值见下表 |  |
| `data.nodes` | Array | 是 | 关联关系中节点信息列表 |  |
| `data.nodes[].id` | String | 是 | 节点的企业id |  |
| `data.nodes[].uid` | String | 是 | 节点在关系图的id |  |
| `data.nodes[].name` | String | 是 | 节点名称 |  |
| `data.nodes[].type` | String | 是 | 节点类型，P个人、E企业、SP特殊企业、LT上市公司、S社会组织、U其他、UE未在工商注册的企业或组织、G政府 |  |
| `data.nodes[].iskey` | String | 是 | 起始节点标识，true表示为起始节点，false表示为中间节点 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 22.36 多家企业间找关系job申请-50家

- Hub：`POST /api/v1/data/enterprise/22.36/query`；上游方法 POST；可调用
- 说明：排查多家企业或者人员之间的投资任职等关系（最多支持50家）），支持关系类型自定义、排查层级自定义，最深可支持7层排查。用获取到的job_id到61.77多家企业间找关系详情中查询数据。

**body 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keywords` | String | 是 | 企业全名字符串或者人员信息字符串, 注意用英文逗号分隔。人员名称前需要用\|定位人员所在具体企业名称， 如：企业 A,企业 B\|人员 B,至多支持50家企业。不可重复。 |
| `is_execute` | Number | 是 | 是否执行，0否1是；若入参中部分企业不存在，剩余企业是否继续创建任务查询； |
| `relations` | String | 否 | 关系类型，不同关系类型用 \| 隔开可根据具体需要选择关系类型， 枚举值：直接关系（默认选入参）SH股东、LR法人、EXEC董监高、HSH历史股东、HLR历史法人、HEXEC历史董监高、branch分支机构；间接关系（可选入参）：SC供应关系、same_phone相同电话号码、same_address相同地址、same_email相同邮箱、same_website相同域名、same_web_email域名关键字和邮箱关键字相同、same_proper_name 相同企业字号、same_lawsuit相同裁判文书、same_software相同软件著作权、same_patent相利、same_history_address相同历史地址、same_history_email 相同的历史邮箱、same_history_phone相同的历史号码 l |
| `level` | Number | 否 | 查询层数（1-7，默认为6层） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.job_id` | String | 是 | 根据job_id到61.77详情中返回数据查询，任务有效期24小时 |  |
| `data.not_found` | Array | 是 | 未找到的企业列表 |  |

### 61.77 多家企业间找关系详情-50家

- Hub：`POST /api/v1/data/enterprise/61.77/query`；上游方法 GET（可选 GET/POST）；可调用
- 说明：根据22.36多家企业间找关系job申请的job_id，获取详细数据。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `job_id` | String | 是 | 22.36多家企业间找关系job申请的job_id |
| `skip` | Number | 否 | 跳过条目数（默认为0），每页10条数据 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].node_one` | String | 是 | 查询企业名 |  |
| `data.items[].node_two` | String | 是 | 查询企业名 |  |
| `data.items[].relations` | Array | 是 | 关系列表 |  |
| `data.items[].relations[].nodes` | Array | 是 | 关联关系中节点信息列表 |  |
| `data.items[].relations[].nodes[].id` | String | 是 | 企业id |  |
| `data.items[].relations[].nodes[].name` | String | 是 | 节点名称 |  |
| `data.items[].relations[].nodes[].is_key` | String | 是 | 起始节点标识，Start为开始节点，End为结束节点，"-"为中间节点 |  |
| `data.items[].relations[].nodes[].label` | String | 是 | P个人、E企业、SP特殊企业、LT上市公司、S社会组织、U其他、UE未在工商注册的企业或组织、G政府 |  |
| `data.items[].relations[].links` | Array | 是 | 关联关系中路径信息列表 |  |
| `data.items[].relations[].links[].start_id` | String | 是 | 关系起节点的id |  |
| `data.items[].relations[].links[].end_id` | String | 是 | 关系终节点的id |  |
| `data.items[].relations[].links[].relation` | String | 是 | 关联关系描述；SH股东、EXEC董监高（DIR董事、SUP监事、EXE高管）、HEXEC历史董监高（（HDIR董事、HSUP监事、HEXE高管））、LR法人、HSH历史股东、branch分支机构、HLR历史法人、same_phone相同电话号码、same_address相同地址、same_email相同邮箱、same_website相同域名、same_web_email域名关键字和邮箱关键字相同、same_proper_name 相同企业字号、same_lawsuit相同裁判文书、same_software相同软件著作权、same_patent相利、same_history_address相同历史地址、same_history_email 相同的历史邮箱、same_history_phone相同的历史号码 |  |
| `data.items[].relations[].links[].detail` | Object | 是 | 关联关系详情 |  |

### 33.14 关联方认定

- Hub：`POST /api/v1/data/enterprise/33.14/query`；上游方法 GET；**不可调用**（无公开价，返回 403 `enterprise_price_negotiated`）
- 说明：通过企业全称/统一社会信用代码获取企业关联关系，以及关联企业之间的持股情况，关系路径等（上交所规则关联关系认定）

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.summery` | Array | 是 | 关联关系中节点信息列表 |  |
| `data.summery[].relation` | String | 是 | 节点关系类型 1：母公司/控股股东 2：母公司/控股股东的疑似控制企业 3：母公司/控股股东的董监高法 4：母公司/控股股东的董监高法的疑似控制企业 5：母公司/控股股东的董监高法的任职企业 6：直接或间接5%以上股权的自然人 7：直接或间接5%以上自然人任职企业 8：直接或间接5%以上自然人控股企业 9：公司的董监高法 10：董监高法的控制企业 11：董监高法的任职企业 12：子公司 13：子公司持股10%以上企业 14：子公司持股10%以上自然人 15：直接或间接5%以上企业 16：实际控制人 17：最终受益人 |  |
| `data.summery[].relationDesc` | String | 是 | 节点关系类型说明，同relation |  |
| `data.summery[].entity` | String | 是 | 节点类型，E、P |  |
| `data.summery[].entityDesc` | String | 是 | 节点类型说明，E：企业，P：自然人 |  |
| `data.summery[].total` | String | 是 | 数据数量 |  |
| `data.summery[].nodes` | Array | 是 | 数组 |  |
| `data.summery[].nodes[].id` | String | 是 | 企业id/自然人id |  |
| `data.summery[].nodes[].name` | String | 是 | 企业名称/自然人名称 |  |
| `data.links` | Array | 是 | 关联关系中路径信息列表 |  |
| `data.links[].sourceId` | String | 是 | 路径源id |  |
| `data.links[].sourceName` | String | 是 | 路径源企业名称/自然人名称 |  |
| `data.links[].targetId` | String | 是 | 路径目标id |  |
| `data.links[].targetName` | String | 是 | 路径目标企业名称/自然人名称 |  |
| `data.links[].relation` | Array | 是 | 关联关系列表 |  |
| `data.links[].relation[].relation` | String | 是 | 节点关系类型（存在包含多种关系的情况）: 1：母公司/控股股东 2：母公司/控股股东的疑似控制企业 3：母公司/控股股东的董监高法 4：母公司/控股股东的董监高法的疑似控制企业 5：母公司/控股股东的董监高法的任职企业 6：直接或间接5%以上股权的自然人 7：直接或间接5%以上自然人任职企业 8：直接或间接5%以上自然人控股企业 9：公司的董监高法 10：董监高法的控制企业 11：董监高法的任职企业 12：子公司 13：子公司持股10%以上企业 14：子公司持股10%以上自然人 15：直接或间接5%以上企业 16：实际控制人 17：最终受益人 |  |
| `data.links[].relation[].effect` | String | 是 | 关联关系方式:1;2 |  |
| `data.links[].relation[].effectDesc` | String | 是 | 关联关系方式描述1：控制,2：影响 |  |
| `data.links[].relation[].reason` | String | 是 | 关联关系原因（任职或者持股） |  |
| `data.eid` | String | 是 | 企业id |  |

### 62.1 同电话企业

- Hub：`POST /api/v1/data/enterprise/62.1/query`；上游方法 GET；可调用
- 说明：根据电话输出相关企业

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `phone` | String | 是 | 联系电话 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 企业信息列表 |  |
| `data.items[].regist_capi` | String | 是 | 注册资本 |  |
| `data.items[].eid` | String | 是 | 企业id |  |
| `data.items[].credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.items[].name` | String | 是 | 企业名称 |  |
| `data.items[].reg_no` | String | 是 | 注册号 |  |
| `data.items[].start_date` | String | 是 | 成立日期 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 27.39 十大受益人

- Hub：`POST /api/v1/data/enterprise/27.39/query`；上游方法 GET；可调用
- 说明：获取企业的十大受益人信息。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | string | 否 | 返回结果状态 |  |
| `sign` | string | 否 | 数据签名 |  |
| `data` | object | 否 | 数据 |  |
| `message` | string | 否 | 返回结果消息 |  |
| `message.id` | String | 否 | 公司id |  |
| `message.name` | String | 否 | 公司名 |  |
| `message.type` | String | 否 | 类型（E: 公司, P: 个人, UE: 其他） |  |
| `message.beneficiary_list` | array | 否 | 十大受益人列表 |  |
| `message.beneficiary_list[].uid` | String | 否 | 公司id / 受益人id |  |
| `message.beneficiary_list[].name` | String | 否 | 公司名或受益人姓名 |  |
| `message.beneficiary_list[].type` | String | 否 | 类型（E: 公司, P: 个人, UE: 其他） |  |
| `message.beneficiary_list[].relationPercentTotal` | String | 否 | 该人/公司对目标企业的总持股比例 |  |
| `message.beneficiary_list[].items` | array | 否 | 十大受益人的受益路径 |  |
| `message.beneficiary_list[].items[].id` | String | 否 | 公司id / 受益人id |  |
| `message.beneficiary_list[].items[].name` | String | 否 | 公司名或受益人姓名 |  |
| `message.beneficiary_list[].items[].type` | String | 否 | 类型（E: 公司, P: 个人, UE: 其他） |  |
| `message.beneficiary_list[].items[].relationPercent` | String | 否 | 该人/公司对目标企业在该路径下的总持股比例 |  |
| `message.beneficiary_list[].items[].breakThroughPercent` | String | 否 | 该人/公司对目标企业在该路径下的穿透持股比例 |  |
| `message.beneficiary_list[].items[].path` | String | 否 | 受益人投资路径，如（例如“xxx有限公司(100%)->南xxx有限公司”） |  |
| `message.beneficiary_list[].items[].level` | String | 否 | 层级 |  |

### 12.62 受益所有人

- Hub：`POST /api/v1/data/enterprise/12.62/query`；上游方法 GET；**不可调用**（无公开价，返回 403 `enterprise_price_negotiated`）
- 说明：根据中国人民银行令〔2025〕第12号（金融机构客户受益所有人识别管理办法）的要求，通过大数据算法计算得出

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名或注册号或统一社会信用代码 |
| `is_far` | Number | 否 | 是否需要加强识别（0否1是）默认为0 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 企业受益人列表 |  |
| `data.items[].beneficiary` | String | 是 | 受益人 |  |
| `data.items[].enterprise` | String | 是 | 企业名称 |  |
| `data.items[].reason` | String | 是 | 受益人说明 |  |
| `data.items[].paths` | Array | 是 | 受益人投资路径（展示所有路径，股东关系会标明股比，任职或法人关系会标明职位代替） |  |
| `data.items[].title` | String | 是 | 任职 |  |
| `data.items[].percent` | String | 是 | 股权占比 |  |
| `data.items[].law_desc` | String | 是 | 条文依据 |  |
| `data.items[].voting_percent` | String | 是 | 表决权比例 |  |
| `data.items[].voting_path` | Array | 是 | 表决权路径 |  |
| `data.items[].benefit_type` | String | 是 | 受益类型 |  |
| `data.items[].benefit_start_time` | String | 是 | 受益开始时间 |  |
| `data.items[].iden_method` | String | 是 | 识别方式 |  |
| `data.items[].econ_kind` | String | 是 | 企业类型 |  |
| `data.items[].record_st` | String | 是 | 备案标准 |  |
| `data.items[].far_type` | String | 是 | 加强识别类型（0：正常 1：境外投资 2：交叉持股 3：频繁更换法定代表人 4：频繁更换高级管理人员） |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

## 企业报告


### 1.13 企业图谱信息

- Hub：`POST /api/v1/data/enterprise/1.13/query`；上游方法 GET；可调用
- 说明：企业工商信息、失信人信息及图谱信息(企业的股东、高管、对外投资、裁判文书、法院公告、历史股东、投资任职关系关联方（相同股东（含历史）、董监高（含历史）、法定代表人），疑似关系关联方（拥有相同的法人、拥有相同的股东、拥有相同的董监高、拥有相同的高管/股东/法人/历史股东）

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配或匹配记录不是最新则创建企业更新job并返回jobid，如果有匹配记录且最新则返回公司信息。具体字段含义见下表 |  |
| `data.chain_relation` | Object | 是 | 企业信息 |  |
| `data.chain_relation.info` | Object | 是 | 企业基本信息 |  |
| `data.chain_relation.info.short_name` | String | 是 | 名称缩写 |  |
| `data.chain_relation.info.id` | String | 是 | 内部企业id |  |
| `data.chain_relation.info.capi_unit` | String | 是 | 注册资本单位 |  |
| `data.chain_relation.info.name` | String | 是 | 企业名称 |  |
| `data.chain_relation.info.status` | String | 是 | 企业状态 |  |
| `data.chain_relation.info.domain` | String | 是 | 所属行业 |  |
| `data.chain_relation.info.start_date` | String | 是 | 成立日期 |  |
| `data.chain_relation.info.address` | String | 是 | 企业地址 |  |
| `data.chain_relation.info.oper_name` | String | 是 | 法人代表人名称 |  |
| `data.chain_relation.info.org_no` | String | 是 | 组织机构代码 |  |
| `data.chain_relation.info.telephone` | String | 是 | 企业电话 |  |
| `data.chain_relation.info.reg_capi` | String | 是 | 企业注册资本 |  |
| `data.chain_relation.info.credit_no` | String | 是 | 企业统一社会信用代码 |  |
| `data.chain_relation.info.reg_no` | String | 是 | 工商注册号 |  |
| `data.chain_relation.node_info` | Object | 是 | 企业链图节点信息 |  |
| `data.chain_relation.node_info.partners` | Array | 是 | 企业股东列表 |  |
| `data.chain_relation.node_info.partners[].percent` | String | 是 | 持股比例 |  |
| `data.chain_relation.node_info.partners[].name` | String | 是 | 股东企业全称 |  |
| `data.chain_relation.node_info.partners[].short_name` | String | 是 | 股东企业名称缩写 |  |
| `data.chain_relation.node_info.partners[].id` | String | 是 | 股东id |  |
| `data.chain_relation.node_info.notices` | Array | 是 | 企业法院公告信息列表 |  |
| `data.chain_relation.node_info.notices[].name` | String | 是 | 企业全称 |  |
| `data.chain_relation.node_info.notices[].short_name` | String | 是 | 企业名称缩写 |  |
| `data.chain_relation.node_info.notices[].id` | String | 是 | 内部企业id |  |
| `data.chain_relation.node_info.suspected_relation` | Array | 是 | 疑似关联关系信息列表（拥有相同的法人 拥有相同的股东 拥有相同的董监高 拥有相同的高管/股东/法人/历史股东） |  |
| `data.chain_relation.node_info.suspected_relation[].related_by` | Array | 是 | 疑似关联关系 |  |
| `data.chain_relation.node_info.suspected_relation[].related_by[].content` | String | 是 | 关联类型描述 |  |
| `data.chain_relation.node_info.suspected_relation[].related_by[].type` | String | 是 | 关联内容 |  |
| `data.chain_relation.node_info.suspected_relation[].name` | String | 是 | 企业全称 |  |
| `data.chain_relation.node_info.suspected_relation[].short_name` | String | 是 | 企业名称缩写 |  |
| `data.chain_relation.node_info.suspected_relation[].id` | String | 是 | 内部企业id |  |
| `data.chain_relation.node_info.lawsuits` | Array | 是 | 企业裁判文书信息列表 |  |
| `data.chain_relation.node_info.lawsuits[].name` | String | 是 | 企业全称 |  |
| `data.chain_relation.node_info.lawsuits[].short_name` | String | 是 | 企业名称缩写 |  |
| `data.chain_relation.node_info.lawsuits[].id` | String | 是 | 内部企业id |  |
| `data.chain_relation.node_info.history_partners` | Array | 是 | 企业历史股东信息列表 |  |
| `data.chain_relation.node_info.history_partners[].name` | String | 是 | 企业全称 |  |
| `data.chain_relation.node_info.history_partners[].short_name` | String | 是 | 企业名称缩写 |  |
| `data.chain_relation.node_info.history_partners[].id` | String | 是 | 内部企业id |  |
| `data.chain_relation.node_info.employees` | Array | 是 | 主要人员信息 |  |
| `data.chain_relation.node_info.employees[].title` | String | 是 | 主要人员职位 |  |
| `data.chain_relation.node_info.employees[].name` | String | 是 | 主要人员姓名 |  |
| `data.chain_relation.node_info.investments` | Array | 是 | 对外投资信息列表 |  |
| `data.chain_relation.node_info.investments[].percent` | String | 是 | 对外投资持股比例 |  |
| `data.chain_relation.node_info.investments[].name` | String | 是 | 对外投资企业名称 |  |
| `data.chain_relation.node_info.investments[].short_name` | String | 是 | 对外投资企业名称缩写 |  |
| `data.chain_relation.node_info.investments[].id` | String | 是 | 内部企业id |  |
| `data.base_info` | Object | 是 | 企业链路关系 |  |
| `data.base_info.regist_capi` | String | 是 | 注册资本 |  |
| `data.base_info.reg_no` | String | 是 | 企业注册号 |  |
| `data.base_info.belong_org` | String | 是 | 所属工商局 |  |
| `data.base_info.address` | String | 是 | 地址 |  |
| `data.base_info.contact` | Object | 是 | 企业联系方式 |  |
| `data.base_info.contact.address` | String | 是 | 地址 |  |
| `data.base_info.contact.telephone` | String | 是 | 电话 |  |
| `data.base_info.contact.email` | String | 是 | 邮件 |  |
| `data.base_info.org_no` | String | 是 | 组织机构号 |  |
| `data.base_info.end_date` | String | 是 | 注销日期 |  |
| `data.base_info.abnormal_items` | Array | 是 | 经营异常信息 |  |
| `data.base_info.abnormal_items[].in_reason` | String | 是 | 经营异常列入原因 |  |
| `data.base_info.abnormal_items[].in_date` | String | 是 | 列入日期 |  |
| `data.base_info.abnormal_items[].out_reason` | String | 是 | 移出原因 |  |
| `data.base_info.abnormal_items[].out_date` | String | 是 | 移出日期 |  |
| `data.base_info.domains` | Array | 是 | 行业 |  |
| `data.base_info.province` | String | 是 | 省份缩写（参见附录province-code） |  |
| `data.base_info.term_end` | String | 是 | 营业结束日期 |  |
| `data.base_info.city` | String | 是 | 城市编码 |  |
| `data.base_info.websites` | Array | 是 | 企业网站信息 |  |
| `data.base_info.websites[].web_type` | String | 是 | 网址类型 |  |
| `data.base_info.websites[].web_url` | String | 是 | 网址 | 🔗 |
| `data.base_info.websites[].source` | String | 是 | 网址来源 |  |
| `data.base_info.websites[].web_name` | String | 是 | 企业网址名称 |  |
| `data.base_info.websites[].date` | String | 是 | 审核时间 |  |
| `data.base_info.websites[].seq_no` | String | 是 | 编号 |  |
| `data.base_info.start_date` | String | 是 | 成立日期 |  |
| `data.base_info.scope` | String | 是 | 经营范围 |  |
| `data.base_info.name` | String | 是 | 企业名称 |  |
| `data.base_info.branches` | Array | 是 | 分支机构 |  |
| `data.base_info.branches[].name` | String | 是 | 分支机构名称 |  |
| `data.base_info.employees` | Array | 是 | 主要人员信息 |  |
| `data.base_info.employees[].job_title` | String | 是 | 主要人员职位 |  |
| `data.base_info.employees[].name` | String | 是 | 主要人员姓名 |  |
| `data.base_info.changerecords` | Array | 是 | 变更记录 |  |
| `data.base_info.changerecords[].before_content` | String | 是 | 变更前内容 |  |
| `data.base_info.changerecords[].change_item` | String | 是 | 变更项目 |  |
| `data.base_info.changerecords[].after_content` | String | 是 | 变更后内容 |  |
| `data.base_info.changerecords[].change_date` | String | 是 | 变更日期 |  |
| `data.base_info.partners` | Array | 是 | 股东信息 |  |
| `data.base_info.partners[].identify_type` | String | 是 | 证照/证件类型 |  |
| `data.base_info.partners[].should_capi_items` | Array | 是 | 认缴出资信息 |  |
| `data.base_info.partners[].should_capi_items[].shoud_capi` | String | 是 | 认缴出资额 |  |
| `data.base_info.partners[].should_capi_items[].should_capi_date` | String | 是 | 出资时间 |  |
| `data.base_info.partners[].should_capi_items[].invest_type` | String | 是 | 出资方式 |  |
| `data.base_info.partners[].stock_type` | String | 是 | 股东类型 |  |
| `data.base_info.partners[].real_capi_items` | Array | 是 | 实缴出资信息 |  |
| `data.base_info.partners[].real_capi_items[].real_capi` | String | 是 | 实缴出资额 |  |
| `data.base_info.partners[].real_capi_items[].real_capi_date` | String | 是 | 出资时间 |  |
| `data.base_info.partners[].real_capi_items[].invest_type` | String | 是 | 出资方式 |  |
| `data.base_info.partners[].name` | String | 是 | 股东姓名 |  |
| `data.base_info.partners[].identify_no` | String | 是 | 证照/证件号码 |  |
| `data.base_info.oper_name` | String | 是 | 法人 |  |
| `data.base_info.credit_no` | String | 是 | 统一社会信用代码 |  |
| `data.base_info.status` | String | 是 | 存续状态 |  |
| `data.base_info.check_date` | String | 是 | 核准日期 |  |
| `data.base_info.econ_kind` | String | 是 | 企业类型 |  |
| `data.base_info.term_start` | String | 是 | 营业开始日期 |  |
| `data.execution_info` | Object | 是 | 司法执行信息 |  |
| `data.execution_info.items` | Array | 是 | 信息 |  |
| `data.execution_info.items[].province` | String | 是 | 省份 |  |
| `data.execution_info.items[].date` | String | 是 | 立案时间 |  |
| `data.execution_info.items[].doc_number` | String | 是 | 执行依据文号 |  |
| `data.execution_info.items[].final_duty` | String | 是 | 生效法律文书确定的义务 |  |
| `data.execution_info.items[].case_number` | String | 是 | 案号 |  |
| `data.execution_info.items[].publish_date` | String | 是 | 发布日期 |  |
| `data.execution_info.items[].court` | String | 是 | 执行法院 |  |
| `data.execution_info.items[].execution_desc` | String | 是 | 失信被执行人行为具体情形 |  |
| `data.execution_info.items[].execution_status` | String | 是 | 被执行人履行情况 |  |
| `data.execution_info.items[].oper_name` | String | 是 | 法定代表人 |  |
| `data.execution_info.items[].number` | String | 是 | 组织机构号 |  |
| `data.execution_info.items[].ex_department` | String | 是 | 做出执行依据单位 |  |

## 企业评分


### 30.3 启信分

- Hub：`POST /api/v1/data/enterprise/30.3/query`；上游方法 GET；**不可调用**（无公开价，返回 403 `enterprise_price_negotiated`）
- 说明：启信宝根据海量企业大数据计算的启信分。（免责声明：评估结果是基于公开大数据计算而成，由于数据不完备，评估结果可能会存在一定的局限性，仅供参考，不能直接作为商业决策的依据。启信宝不对数据真实性、准确性、全面性、时效性负责，不承担使用者的任何商业风险，同时也不保证观点或陈述不发生任何变更。）

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业名称/统一社会信用代码/注册号 |
| `incl_branches` | String | 否 | 是否包含查询分支机构，0：否，1：是，默认0不支持查询分支机构评分，填入1，则输入分支机构会返回分支机构所属总公司评分情况。 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.eid` | String | 是 | 企业id |  |
| `data.ename` | String | 是 | 企业名称 |  |
| `data.score` | Number | 是 | 启信分 |  |
| `data.row_update_time` | String | 是 | 更新时间 |  |
| `data.score_level` | String | 是 | 评级 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 30.4 启信分详情

- Hub：`POST /api/v1/data/enterprise/30.4/query`；上游方法 GET；**不可调用**（无公开价，返回 403 `enterprise_price_negotiated`）
- 说明：启信分详情，包含企业资本背景，企业规模，成长性，知识产权，经营质量，风险状况的行业排名信息。（免责声明：评估结果是基于公开大数据计算而成，由于数据不完备，评估结果可能会存在一定的局限性，仅供参考，不能直接作为商业决策的依据。启信宝不对数据真实性、准确性、全面性、时效性负责，不承担使用者的任何商业风险，同时也不保证观点或陈述不发生任何变更。）

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全称/统一社会信用代码/注册号 |
| `incl_branches` | String | 否 | 是否包含查询分支机构，0：否，1：是，默认0不支持查询分支机构评分，填入1，则输入分支机构会返回分支机构所属总公司评分情况。 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.scale_rank` | Number | 是 | 企业规模-行业排名 |  |
| `data.row_update_time` | String | 是 | 更新时间 |  |
| `data.intellectual_property_score` | Number | 是 | 知识产权 |  |
| `data.intellectual_property_rank` | Number | 是 | 知识产权-行业排名 |  |
| `data.growth_rank` | Number | 是 | 成长性-行业排名 |  |
| `data.final_score` | Number | 是 | 加权得分 |  |
| `data.capital_background_score` | Number | 是 | 资本背景 |  |
| `data.score` | Number | 是 | 启信分 |  |
| `data.ename` | String | 是 | 企业名称 |  |
| `data.total_rank` | Number | 是 | 启信分-行业排名 |  |
| `data.quality_score` | Number | 是 | 经营质量 |  |
| `data.quality_rank` | Number | 是 | 经营质量-行业排名 |  |
| `data.score_level` | String | 是 | 评级 |  |
| `data.growth_score` | Number | 是 | 成长性 |  |
| `data.eid` | String | 是 | 企业id |  |
| `data.capital_background_rank` | Number | 是 | 资本背景-行业排名 |  |
| `data.positive_score` | Number | 是 | 实力分 |  |
| `data.scale_score` | Number | 是 | 企业规模 |  |
| `data.negative_score` | Number | 是 | 风险分 |  |
| `data.risk_rank` | Number | 是 | 风险状况-行业排名 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 55.55 启信分波动

- Hub：`POST /api/v1/data/enterprise/55.55/query`；上游方法 GET；**不可调用**（无公开价，返回 403 `enterprise_price_negotiated`）
- 说明：获取启信分波动变化

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | string | 是 |  |
| `skip` | number | 否 |  |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | string | 否 | 返回结果状态 |  |
| `sign` | string | 否 | 数据签名 |  |
| `data` | object | 否 | 数据 |  |
| `data.total` | number | 否 | 返回列表中记录总数 |  |
| `data.num` | number | 否 | 本次调用返回记录数 |  |
| `data.items` | array | 否 | 启信分波动列表 |  |
| `data.items[].u_tags` | number | 否 | 是否隐藏，0：不隐藏，2：隐藏 |  |
| `data.items[].qxf_sum_old` | number | 否 | 变动前启信分 |  |
| `data.items[].change_type` | number | 否 | 波动类型 |  |
| `data.items[].ename` | string | 否 | 企业名称 |  |
| `data.items[].change_start_date` | string | 否 | 波动开始日期 |  |
| `data.items[].row_update_time` | string | 否 | 记录更新时间 |  |
| `data.items[].change_direction` | string | 否 | 变动方向 |  |
| `data.items[].unique_id` | string | 否 | 唯一键 |  |
| `data.items[].qxf_diff` | number | 否 | 变动幅度 |  |
| `data.items[].eid` | string | 否 | 企业主键 |  |
| `data.items[].qxf_sum_new` | number | 否 | 变动后启信分 |  |
| `data.items[].id` | string | 否 | 自增主键 |  |
| `data.items[].create_time` | string | 否 | 记录创建时间 |  |
| `data.items[].change_end_date` | string | 否 | 波动结束日期 |  |
| `data.items[].change_reasons` | string | 否 | 变动原因 |  |
| `message` | string | 否 | 返回结果消息 |  |

### 82.1 企业空壳指数

- Hub：`POST /api/v1/data/enterprise/82.1/query`；上游方法 GET；**不可调用**（无公开价，返回 403 `enterprise_price_negotiated`）
- 说明：企业空壳信息，包括空壳指数、空壳等级等，其中空壳等级为“4或5”代表高概率是空壳企业，建议审慎审核对应企业；空壳等级为“3”代表中概率是空壳企业，建议进一步审核对应企业；空壳等级为“1或2”代表低概率是空壳企业。（免责声明：评估结果是基于公开大数据计算而成，由于数据不完备，评估结果可能会存在一定的局限性，仅供参考，不能直接作为商业决策的依据。启信宝不对数据真实性、准确性、全面性、时效性负责，不承担使用者的任何商业风险，同时也不保证观点或陈述不发生任何变更。）

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.score` | Number | 是 | 空壳指数 |  |
| `data.name` | String | 是 | 企业名称 |  |
| `data.eid` | String | 是 | 企业id |  |
| `data.level` | Number | 是 | 空壳等级 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 82.3 企业空壳指数详情

- Hub：`POST /api/v1/data/enterprise/82.3/query`；上游方法 GET；**不可调用**（无公开价，返回 403 `enterprise_price_negotiated`）
- 说明：空壳指数主要用于识别套牌公司、僵尸企业、皮包公司等非正常经营的企业，启信宝从企业经营场所、资产形态、企业人员、经营活动、经营资质以及风险信息对该企业进行六维扫描。（免责声明：评估结果是基于公开大数据计算而成，由于数据不完备，评估结果可能会存在一定的局限性，仅供参考，不能直接作为商业决策的依据。启信宝不对数据真实性、准确性、全面性、时效性负责，不承担使用者的任何商业风险，同时也不保证观点或陈述不发生任何变更。）

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.eid` | String | 是 | 企业ID |  |
| `data.items` | Object | 是 | 为命中空壳标签数组（如果未命中则为空，通过六维扫描暂未发现该公司存在空壳特征） |  |
| `data.items.hit` | Array | 是 | 命中类标签 |  |
| `data.items.suggestion` | Array | 是 | 提示类标签 |  |
| `data.name` | String | 是 | 企业名称 |  |
| `data.level` | Number | 是 | 空壳等级 |  |
| `data.score` | Number | 是 | 空壳指数 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 79.22 司法风险评分

- Hub：`POST /api/v1/data/enterprise/79.22/query`；上游方法 GET；**不可调用**（无公开价，返回 403 `enterprise_price_negotiated`）
- 说明：根据企业全名/注册号/统一社会信用代码获得司法风险评分相关信息。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `risk_type` | Number | 否 | 风险类别 risk_type 代码 标准类型 1 违法犯罪 2 知识产权 3 劳动纠纷 4 商业纠纷 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `sign` | string | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.industry_code_l2` | String | 是 | 二级行业代码 |  |
| `data.industry_name` | String | 是 | 行业分类（国民经济分类） |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].case_type` | String | 是 | 案件类型 |  |
| `data.items[].risk_score` | String | 是 | 风险评分（分低为宜） |  |
| `data.items[].conclusion` | String | 是 | 风险描述 |  |
| `message` | string | 是 | 返回结果消息 |  |

### 79.23 司法风险评分详情

- Hub：`POST /api/v1/data/enterprise/79.23/query`；上游方法 GET；**不可调用**（无公开价，返回 403 `enterprise_price_negotiated`）
- 说明：根据企业全名/注册号/统一社会信用代码获得司法风险评分详情信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `risk_type` | Number | 是 | 风险类别 risk_type 代码 标准类型 1 违法犯罪 2 知识产权 3 劳动纠纷 4 商业纠纷 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `sign` | string | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.industry_code_l2` | String | 是 | 二级行业代码 |  |
| `data.industry_name` | String | 是 | 行业分类（国民经济分类） |  |
| `data.case_type` | String | 是 | 案件类型 |  |
| `data.amount_d` | Number | 是 | 涉诉总额（被告） |  |
| `data.amount_d_rank` | Number | 是 | 涉诉总额（被告）的业内排名 |  |
| `data.count_d` | Number | 是 | 涉诉案件（被告） |  |
| `data.count_d_rank` | String | 是 | 涉诉案件（被告）的业内排名 |  |
| `data.amount_p` | Number | 是 | 涉诉总额（原告） |  |
| `data.amount_p_rank` | Number | 是 | 涉诉总额（原告）的业内排名 |  |
| `data.count_p` | Number | 是 | 涉诉案件（原告） |  |
| `data.count_p_rank` | Number | 是 | 涉诉案件（原告）的业内排名 |  |
| `data.risk_score` | Number | 是 | 风险评分（分低为宜） |  |
| `data.risk_score_rank` | Number | 是 | 风险评分的业内排名 |  |
| `data.conclusion` | String | 是 | 风险描述 |  |
| `message` | string | 否 | 返回结果消息 |  |

### 66.21 合同违约指数

- Hub：`POST /api/v1/data/enterprise/66.21/query`；上游方法 GET；**不可调用**（无公开价，返回 403 `enterprise_price_negotiated`）
- 说明：合同违约指数信息，包括违约规模、违约次数、被执行次数、合同违约指数等信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.u_tags` | String | 是 | 是否隐藏 |  |
| `data.default_amount_industry_median` | String | 是 | 违约规模的行业中位数 |  |
| `data.id` | String | 是 | 企业id |  |
| `data.name` | String | 是 | 企业名称 |  |
| `data.default_risk` | String | 是 | 合同违约风险水平 |  |
| `data.default_index` | String | 是 | 合同违约指数 |  |
| `data.default_amount_industry_average` | String | 是 | 违约规模的行业平均值 |  |
| `data.default_rating` | String | 是 | 合同违约评级 |  |
| `data.default_amount_ranking` | String | 是 | 违约规模的行业内排名 |  |
| `data.enforce_count` | String | 是 | 被执行次数 |  |
| `data.default_count` | String | 是 | 违约次数 |  |
| `data.default_amount` | Number | 是 | 违约规模 |  |
| `data.default_amount_industry_ranking` | String | 是 | 行业特征排名 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 83.52 企业科技创新能力评分

- Hub：`POST /api/v1/data/enterprise/83.52/query`；上游方法 GET；可调用
- 说明：根据企业名称、注册号、统一社会信用代码获取科技创新能力评分

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果 |  |
| `data.science_technology_original_scor` | Number | 是 | 企业科创力原始得分 |  |
| `data.science_technology_original_leve` | String | 是 | 企业科创力原始等级 |  |
| `data.science_technology_original_rank` | Number | 是 | 企业科创力原始得分排名（按二级行业） |  |
| `data.science_technology_adjust_score` | Number | 是 | 企业科创力调整后得分 |  |
| `data.science_technology_adjust_level` | String | 是 | 企业科创力调整后等级 |  |
| `data.science_technology_adjust_rank` | Number | 是 | 企业科创力调整后得分排名（按二级行业） |  |
| `data.sci_tec_adjust_country_rank` | Number | 是 | 科创力得分的行业排名（按全国） |  |
| `data.sci_tec_adjust_province_rank` | Number | 是 | 科创力得分的行业排名（按省份） |  |
| `data.sci_tec_adjust_city_rank` | Number | 是 | 科创力得分的行业排名（按城市） |  |
| `data.sci_tec_adjust_region_rank` | Number | 是 | 科创力得分的行业排名（按地区） |  |
| `data.technology_layout_score` | Number | 是 | 技术布局得分 |  |
| `data.technology_value_score` | Number | 是 | 技术价值得分 |  |
| `data.technology_influence_score` | Number | 是 | 技术影响力得分 |  |
| `data.technology_ability_score` | Number | 是 | 研发规模/科创成果/研发能力得分 |  |
| `data.technology_team_score` | Number | 是 | 研发团队得分 |  |
| `data.technology_stability_score` | Number | 是 | 研发稳定性得分 |  |
| `data.technology_efficiency_score` | Number | 是 | 研发效率得分 |  |
| `data.technology_honor_score` | Number | 是 | 科创荣誉/资质得分 |  |
| `data.technology_layout_rank` | Number | 是 | 技术布局行业排名得分 |  |
| `data.technology_value_rank` | Number | 是 | 技术价值行业排名得分 |  |
| `data.technology_influence_rank` | Number | 是 | 技术影响力行业排名得分 |  |
| `data.technology_ability_rank` | Number | 是 | 研发规模/科创成果/研发能力行业排名得分 |  |
| `data.technology_team_rank` | Number | 是 | 研发团队行业排名得分 |  |
| `data.technology_stability_rank` | Number | 是 | 研发稳定性行业排名得分 |  |
| `data.technology_efficiency_rank` | Number | 是 | 研发效率行业排名得分 |  |
| `data.technology_honor_rank` | Number | 是 | 科创荣誉/资质行业排名得分 |  |
| `data.fmzl_valid` | Number | 是 | 有效发明专利数量（企业本身） |  |
| `data.fmsq_valid` | Number | 是 | 有效发明授权数量（企业本身） |  |
| `data.syxx_valid` | Number | 是 | 有效实用新型数量（企业本身） |  |
| `data.wgsj_valid` | Number | 是 | 有效外观设计数量（企业本身） |  |
| `data.copyright_s` | Number | 是 | 软著数量（企业本身） |  |
| `data.patent_valid` | Number | 是 | 有效专利总数（企业本身） |  |
| `data.cnt_valid_fmzl_unauthorized` | Number | 是 | 有效未授权发明专利数量（包含分子公司） |  |
| `data.cnt_valid_fmzl_authorized` | Number | 是 | 有效已授权发明专利数量（包含分子公司） |  |
| `data.cnt_valid_syxx` | Number | 是 | 有效实用新型专利数量（包含分子公司） |  |
| `data.cnt_valid_wgsj` | Number | 是 | 有效外观设计专利数量（包含分子公司） |  |
| `data.cnt_valid_copyright_s` | Number | 是 | 有效软件著作权数量（包含分子公司） |  |
| `data.patent_valid_ct` | Number | 是 | 有效专利总数（包含分子公司） |  |
| `data.kc_label` | String | 是 | 科创标签 |  |
| `data.emerging_l1` | String | 是 | 所属新兴产业领域 |  |

### 91.74 企业科技创新能力评分详情

- Hub：`POST /api/v1/data/enterprise/91.74/query`；上游方法 GET；可调用
- 说明：根据企业名称、注册号、统一社会信用代码获取企业科创力得分，包括IPC分类数量得分，技术布局得分，技术价值得分，专利许可数得分等信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 数据 |  |
| `data.eid` | String | 是 | 企业编码 |  |
| `data.ename` | String | 是 | 企业名称 |  |
| `data.technology_layout_score` | String | 是 | 技术布局得分 |  |
| `data.cnt_category_num_ipc_score` | String | 是 | IPC分类数量得分 |  |
| `data.cnt_pct_applications_score` | String | 是 | PCT申请量得分 |  |
| `data.cnt_industry_research_co_score` | String | 是 | 产学研合作得分 |  |
| `data.cnt_industry_research_ent_score` | String | 是 | 产学研合作申请的单位数得分 |  |
| `data.cnt_industry_research_patent_sco` | String | 是 | 产学研合作申请专利数得分 |  |
| `data.cnt_patent_words_score` | String | 是 | 技术广度得分 |  |
| `data.cnt_families_num_score` | String | 是 | 同族专利数量（专利优先权）得分 |  |
| `data.cnt_applicant_co_score` | String | 是 | 专利联合申请人数量（统计人数）得分 |  |
| `data.cnt_patent_co_score` | String | 是 | 专利联合申请数量（统计专利个数）得分 |  |
| `data.cnt_req_country_score` | String | 是 | 专利全球布局（统计布局国家个数）得分 |  |
| `data.technology_value_score` | String | 是 | 技术价值得分 |  |
| `data.cnt_high_degree_patent_score` | String | 是 | 高价值专利数量得分 |  |
| `data.ratio_high_degree_patent_score` | String | 是 | 高价值专利数量占比得分 |  |
| `data.cnt_original_num_score` | String | 是 | 专利分案子案个数得分 |  |
| `data.avg_patent_value_degree_score` | String | 是 | 专利价值度平均分得分 |  |
| `data.total_final_patent_amount_w_scor` | String | 是 | 专利价值总和（元）得分 |  |
| `data.avg_patent_high_value_degree_sco` | String | 是 | 专利价值top10的平均分得分 |  |
| `data.avg_final_patent_amount_w_score` | String | 是 | 专利平均价值（元）得分 |  |
| `data.cnt_example_num_score` | String | 是 | 专利实施例个数得分 |  |
| `data.technology_influence_score` | String | 是 | 技术影响力得分 |  |
| `data.cnt_high_patent_prc_num_score` | String | 是 | 高价值专利被引用次数得分 |  |
| `data.avg_high_patent_prc_num_score` | String | 是 | 高价值专利平均被引用次数得分 |  |
| `data.cnt_patent_prc_num_score` | String | 是 | 专利被引用次数得分 |  |
| `data.avg_patent_prc_num_score` | String | 是 | 专利平均被引用次数得分 |  |
| `data.cnt_permit_num_score` | String | 是 | 专利许可数得分 |  |
| `data.technology_ability_score` | String | 是 | 研发规模/科创成果/研发能力得分 |  |
| `data.cnt_valid_fmzl_unauthorized_1yr_` | String | 是 | 近1年有效未授权发明专利数量得分 |  |
| `data.cnt_valid_fmzl_authorized_1yr_sc` | String | 是 | 近1年有效已授权发明专利数量得分 |  |
| `data.cnt_valid_fmzl_unauthorized_3yrs` | String | 是 | 近3年有效未授权发明专利数量得分 |  |
| `data.cnt_valid_fmzl_authorized_3yrs_s` | String | 是 | 近3年有效已授权发明专利数量得分 |  |
| `data.cnt_valid_copyright_s_score` | String | 是 | 有效软件著作权数量得分 |  |
| `data.cnt_valid_syxx_score` | String | 是 | 有效实用新型专利数量得分 |  |
| `data.ratio_valid_syxx_score` | String | 是 | 有效实用新型专利数量占比得分 |  |
| `data.cnt_valid_wgsj_score` | String | 是 | 有效外观设计专利数量得分 |  |
| `data.cnt_valid_fmzl_unauthorized_scor` | String | 是 | 有效未授权发明专利数量得分 |  |
| `data.ratio_valid_fmzl_unauthorized_sc` | String | 是 | 有效未授权发明专利数量占比得分 |  |
| `data.cnt_valid_fmzl_authorized_score` | String | 是 | 有效已授权发明专利数量得分 |  |
| `data.ratio_valid_fmzl_authorized_scor` | String | 是 | 有效已授权发明专利数量占比得分 |  |
| `data.cnt_original_transfer_patent_sco` | String | 是 | 原创专利转移数量得分 |  |
| `data.technology_team_score` | String | 是 | 研发团队得分 |  |
| `data.cnt_designer_score` | String | 是 | 发明人规模得分 |  |
| `data.cnt_core_team_score` | String | 是 | 核心团队人数得分 |  |
| `data.cnt_active_designer_score` | String | 是 | 活跃发明人规模得分 |  |
| `data.technicist_proportion_score` | String | 是 | 技术人员规模占比得分 |  |
| `data.research_and_development_bk_scor` | String | 是 | 研发背景得分 |  |
| `data.if_award_people_score` | String | 是 | 有无科技人才得分 |  |
| `data.technology_stability_score` | String | 是 | 研发稳定性得分 |  |
| `data.copyright_s_growth_ratio_score` | String | 是 | 有效软件著作权增长率得分 |  |
| `data.valid_syxx_growth_ratio_score` | String | 是 | 有效实用新型专利增长率得分 |  |
| `data.valid_wgsj_growth_ratio_score` | String | 是 | 有效外观设计专利增长率得分 |  |
| `data.fmzl_unauthorized_growth_ratio_s` | String | 是 | 有效未授权发明专利增长率得分 |  |
| `data.maintain_cycle_score` | String | 是 | 高价值专利入局年限得分 |  |
| `data.cnt_patent_rest_yr_score` | String | 是 | 专利寿命得分 |  |
| `data.technology_efficiency_score` | String | 是 | 研发效率得分 |  |
| `data.cnt_patents_per_designer_score` | String | 是 | 人均研发产出效率（专利数量）得分 |  |
| `data.cnt_patents_per_industry_score` | String | 是 | 行业研发效率（专利数量）对比得分 |  |
| `data.cnt_maintain_cycle_score` | String | 是 | 技术更新周期-专利维持年限得分 |  |
| `data.patent_request_total_5yr_score` | String | 是 | 近5年年均专利申请数得分 |  |
| `data.technology_honor_score` | String | 是 | 科创荣誉/资质得分 |  |
| `data.cnt_kc_label_score` | String | 是 | 企业创新资质数量-科创标签得分 |  |
| `data.if_standard_score` | String | 是 | 企业有无国家/行业标准制定得分 |  |
| `data.if_rd_organization_score` | String | 是 | 企业有无科研相关机构得分 |  |
| `data.if_ent_honor_score` | String | 是 | 企业荣誉得分 |  |
| `data.fmzl_authorized_growth_ratio_sco` | String | 是 | 有效已授权发明专利增长率得分 |  |
| `data.science_technology_score` | String | 是 | 企业科创力得分 |  |
| `data.science_technology_level` | String | 是 | 企业科创力等级 |  |
| `data.science_technology_rank` | String | 是 | 科创力得分排名（按二级行业） |  |

### 95.03 企业科技创新能力评分模型指标

- Hub：`POST /api/v1/data/enterprise/95.03/query`；上游方法 GET（可选 GET/POST）；可调用
- 说明：根据企业名称、注册号、统一社会信用代码获取企业IPC分类数量、PCT申请量、产学研合作、技术广度、高价值专利数量等科创详情信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 数据 |  |
| `data.eid` | String | 是 | 企业编码 |  |
| `data.ename` | String | 是 | 企业名称 |  |
| `data.technology_layout_score` | String | 是 | 技术布局得分 |  |
| `data.cnt_category_num_ipc` | String | 是 | IPC分类数量 |  |
| `data.cnt_pct_applications` | String | 是 | PCT申请量 |  |
| `data.cnt_industry_research_co` | String | 是 | 产学研合作 |  |
| `data.cnt_industry_research_ent` | String | 是 | 产学研合作申请的单位数 |  |
| `data.cnt_industry_research_patent` | String | 是 | 产学研合作申请专利数 |  |
| `data.cnt_patent_words` | String | 是 | 技术广度 |  |
| `data.cnt_families_num` | String | 是 | 同族专利数量（专利优先权） |  |
| `data.cnt_applicant_co` | String | 是 | 专利联合申请人数量（统计人数） |  |
| `data.cnt_patent_co` | String | 是 | 专利联合申请数量（统计专利个数） |  |
| `data.cnt_req_country` | String | 是 | 专利全球布局（统计布局国家个数） |  |
| `data.technology_value_score` | String | 是 | 技术价值得分 |  |
| `data.cnt_high_degree_patent` | String | 是 | 高价值专利数量 |  |
| `data.ratio_high_degree_patent` | String | 是 | 高价值专利数量占比 |  |
| `data.cnt_original_num` | String | 是 | 专利分案子案个数 |  |
| `data.avg_patent_value_degree` | String | 是 | 专利价值度平均分 |  |
| `data.total_final_patent_amount_w` | String | 是 | 专利价值总和（元） |  |
| `data.avg_patent_high_value_degree` | String | 是 | 专利价值top10的平均分 |  |
| `data.avg_final_patent_amount_w` | String | 是 | 专利平均价值（元） |  |
| `data.cnt_example_num` | String | 是 | 专利实施例个数 |  |
| `data.technology_influence_score` | String | 是 | 技术影响力得分 |  |
| `data.cnt_high_patent_prc_num` | String | 是 | 高价值专利被引用次数 |  |
| `data.avg_high_patent_prc_num` | String | 是 | 高价值专利平均被引用次数 |  |
| `data.cnt_patent_prc_num` | String | 是 | 专利被引用次数 |  |
| `data.avg_patent_prc_num` | String | 是 | 专利平均被引用次数 |  |
| `data.cnt_permit_num` | String | 是 | 专利许可数 |  |
| `data.technology_ability_score` | String | 是 | 研发规模/科创成果/研发能力得分 |  |
| `data.cnt_valid_fmzl_unauthorized_1yr` | String | 是 | 近1年有效未授权发明专利数量 |  |
| `data.cnt_valid_fmzl_authorized_1yr` | String | 是 | 近1年有效已授权发明专利数量 |  |
| `data.cnt_valid_fmzl_unauthorized_3yrs` | String | 是 | 近3年有效未授权发明专利数量 |  |
| `data.cnt_valid_fmzl_authorized_3yrs` | String | 是 | 近3年有效已授权发明专利数量 |  |
| `data.cnt_valid_copyright_s` | String | 是 | 有效软件著作权数量 |  |
| `data.cnt_valid_syxx` | String | 是 | 有效实用新型专利数量 |  |
| `data.ratio_valid_syxx` | String | 是 | 有效实用新型专利数量占比 |  |
| `data.cnt_valid_wgsj` | String | 是 | 有效外观设计专利数量 |  |
| `data.cnt_valid_fmzl_unauthorized` | String | 是 | 有效未授权发明专利数量 |  |
| `data.ratio_valid_fmzl_unauthorized` | String | 是 | 有效未授权发明专利数量占比 |  |
| `data.cnt_valid_fmzl_authorized` | String | 是 | 有效已授权发明专利数量 |  |
| `data.ratio_valid_fmzl_authorized` | String | 是 | 有效已授权发明专利数量占比 |  |
| `data.cnt_original_transfer_patent` | String | 是 | 原创专利转移数量 |  |
| `data.technology_team_score` | String | 是 | 研发团队得分 |  |
| `data.cnt_designer` | String | 是 | 发明人规模 |  |
| `data.cnt_core_team` | String | 是 | 核心团队人数 |  |
| `data.cnt_active_designer` | String | 是 | 活跃发明人规模 |  |
| `data.technicist_proportion` | String | 是 | 技术人员规模占比 |  |
| `data.research_and_development_bk` | String | 是 | 研发背景 |  |
| `data.if_award_people` | String | 是 | 有无科技人才 |  |
| `data.technology_stability_score` | String | 是 | 研发稳定性得分 |  |
| `data.copyright_s_growth_ratio` | String | 是 | 有效软件著作权增长率 |  |
| `data.valid_syxx_growth_ratio` | String | 是 | 有效实用新型专利增长率 |  |
| `data.valid_wgsj_growth_ratio` | String | 是 | 有效外观设计专利增长率 |  |
| `data.fmzl_unauthorized_growth_ratio` | String | 是 | 有效未授权发明专利增长率 |  |
| `data.fmzl_authorized_growth_ratio` | String | 是 | 有效已授权发明专利增长率 |  |
| `data.maintain_cycle` | String | 是 | 高价值专利入局年限 |  |
| `data.cnt_patent_rest_yr` | String | 是 | 专利寿命 |  |
| `data.technology_efficiency_score` | String | 是 | 研发效率得分 |  |
| `data.cnt_patents_per_designer` | String | 是 | 人均研发产出效率（专利数量） |  |
| `data.cnt_patents_per_industry` | String | 是 | 行业研发效率（专利数量）对比 |  |
| `data.cnt_maintain_cycle` | String | 是 | 技术更新周期-专利维持年限 |  |
| `data.patent_request_total_5yr` | String | 是 | 近5年年均专利申请数 |  |
| `data.technology_honor_score` | String | 是 | 科创荣誉/资质得分 |  |
| `data.cnt_kc_label` | String | 是 | 企业创新资质数量-科创标签 |  |
| `data.if_standard` | String | 是 | 企业有无国家/行业标准制定 |  |
| `data.if_rd_organization` | String | 是 | 企业有无科研相关机构 |  |
| `data.if_ent_honor` | String | 是 | 企业荣誉 |  |
| `data.science_technology_score` | String | 是 | 企业科创力得分 |  |
| `data.science_technology_level` | String | 是 | 企业科创力等级 |  |
| `data.science_technology_rank` | String | 是 | 科创力得分排名（按二 |  |

### 86.83 科创企业综合评分

- Hub：`POST /api/v1/data/enterprise/86.83/query`；上游方法 GET；可调用
- 说明：根据企业名称、注册号、统一社会信用代码获取科创企业综合评分

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 数据 |  |
| `data.science_technology_original_scor` | Number | 是 | 企业科创力得分（一级） |  |
| `data.technology_layout_score` | Number | 是 | 技术布局得分（二级） |  |
| `data.technology_value_score` | Number | 是 | 技术价值得分（二级） |  |
| `data.technology_influence_score` | Number | 是 | 技术影响力得分（二级） |  |
| `data.technology_ability_score` | Number | 是 | 研发规模/科创成果/研发能力得分（二级） |  |
| `data.technology_team_score` | Number | 是 | 研发团队得分（二级） |  |
| `data.technology_stability_score` | Number | 是 | 研发稳定性得分（二级） |  |
| `data.technology_efficiency_score` | Number | 是 | 研发效率得分（二级） |  |
| `data.technology_honor_score` | Number | 是 | 科创荣誉/资质得分（二级） |  |
| `data.operating_stability_score` | Number | 是 | 经营稳定性得分（一级） |  |
| `data.ent_background_score` | Number | 是 | 企业背景得分（二级） |  |
| `data.ent_scale_score` | Number | 是 | 企业规模得分（二级） |  |
| `data.ent_maturity_scale_score` | Number | 是 | 企业成熟度得分（二级） |  |
| `data.operating_ability_score` | Number | 是 | 经营能力得分（一级） |  |
| `data.operating_performance_score` | Number | 是 | 经营业绩得分（二级） |  |
| `data.ent_growth_score` | Number | 是 | 企业成长性得分（二级） |  |
| `data.ent_honor_score` | Number | 是 | 优质资质荣誉得分（二级） |  |
| `data.finance_ability_score` | Number | 是 | 融资能力得分（二级） |  |
| `data.industry_potentiality_score` | Number | 是 | 行业潜力得分（一级） |  |
| `data.capi_trending_score` | Number | 是 | 资本热度得分（二级） |  |
| `data.policy_trending_score` | Number | 是 | 政策导向得分（二级） |  |
| `data.innovation_environment_score` | Number | 是 | 行业/产业创新环境得分 |  |
| `data.finance_capacity_score` | Number | 是 | 行业/产业财务能力得分 |  |
| `data.operating_risk_score` | Number | 是 | 经营风险得分（一级） |  |
| `data.research_develop_risk_rank` | Number | 是 | 研发风险行业排名得分（二级） |  |
| `data.credit_risk_rank` | Number | 是 | 信用风险行业排名得分（二级） |  |
| `data.kc_original_score` | Number | 是 | 科创企业综合评分（原始） |  |
| `data.kc_original_level` | String | 是 | 科创企业综合评级（原始） |  |
| `data.kc_adjust_score` | Number | 是 | 科创企业综合评分（调整后） |  |
| `data.kc_adjust_level` | String | 是 | 科创企业综合评级（调整后） |  |
| `data.kc_adjust_indus_rank` | Number | 是 | 科创综合评分的行业排名（按二级行业） |  |
| `data.kc_adjust_country_indus_rank` | Number | 是 | 科创综合评分的行业排名（按全国） |  |
| `data.kc_adjust_province_indus_rank` | Number | 是 | 科创综合评分的行业排名（按省份） |  |
| `data.kc_adjust_city_indus_rank` | Number | 是 | 科创综合评分的行业排名（按城市） |  |
| `data.kc_adjust_region_indus_rank` | Number | 是 | 科创综合评分的行业排名（按地区） |  |
| `data.research_develop_risk_score` | Number | 是 | 研发风险得分（二级） |  |
| `data.credit_risk_score` | Number | 是 | 信用风险得分（二级） |  |
| `data.technology_layout_rank` | Number | 是 | 技术布局行业排名得分（二级） |  |
| `data.technology_value_rank` | Number | 是 | 技术价值行业排名得分（二级） |  |
| `data.technology_influence_rank` | Number | 是 | 技术影响力行业排名得分（二级） |  |
| `data.technology_ability_rank` | Number | 是 | 研发规模/科创成果/研发能力行业排名得分（二级） |  |
| `data.technology_team_rank` | Number | 是 | 研发团队行业排名得分（二级） |  |
| `data.technology_stability_rank` | Number | 是 | 研发稳定性行业排名得分（二级） |  |
| `data.technology_efficiency_rank` | Number | 是 | 研发效率行业排名得分（二级） |  |
| `data.technology_honor_rank` | Number | 是 | 科创荣誉/资质行业排名得分（二级） |  |
| `data.science_technology_original_rank` | Number | 是 | 企业科创力行业排名得分（一级） |  |
| `data.ent_background_rank` | Number | 是 | 企业背景行业排名得分（二级） |  |
| `data.ent_scale_rank` | Number | 是 | 企业规模行业排名得分（二级） |  |
| `data.ent_maturity_scale_rank` | Number | 是 | 企业成熟度行业排名得分（二级） |  |
| `data.operating_stability_rank` | Number | 是 | 经营稳定性行业排名得分（一级） |  |
| `data.operating_performance_rank` | Number | 是 | 经营业绩行业排名得分（二级） |  |
| `data.ent_growth_rank` | Number | 是 | 企业成长性行业排名得分（二级） |  |
| `data.ent_honor_rank` | Number | 是 | 优质资质荣誉行业排名得分（二级） |  |
| `data.finance_ability_rank` | Number | 是 | 融资能力行业排名得分（二级） |  |
| `data.operating_ability_rank` | Number | 是 | 经营能力行业排名得分（一级） |  |
| `data.capi_trending_rank` | Number | 是 | 资本热度行业排名得分（二级） |  |
| `data.policy_trending_rank` | Number | 是 | 政策导向行业排名得分（二级） |  |
| `data.industry_potentiality_rank` | Number | 是 | 行业潜力行业排名得分（一级） |  |
| `data.operating_risk_rank` | Number | 是 | 经营风险行业排名得分（一级） |  |
| `data.fmzl_valid` | Number | 是 | 有效发明专利数量（企业本身） |  |
| `data.fmsq_valid` | Number | 是 | 有效发明授权数量（企业本身） |  |
| `data.syxx_valid` | Number | 是 | 有效实用新型数量（企业本身） |  |
| `data.wgsj_valid` | Number | 是 | 有效外观设计数量（企业本身） |  |
| `data.copyright_s` | Number | 是 | 软著数量（企业本身） |  |
| `data.patent_valid` | Number | 是 | 有效专利总数（企业本身） |  |
| `data.cnt_valid_fmzl_unauthorized` | Number | 是 | 有效未授权发明专利数量（包含分子公司） |  |
| `data.cnt_valid_fmzl_authorized` | Number | 是 | 有效已授权发明专利数量（包含分子公司） |  |
| `data.cnt_valid_syxx` | Number | 是 | 有效实用新型专利数量（包含分子公司） |  |
| `data.cnt_valid_wgsj` | Number | 是 | 有效外观设计专利数量（包含分子公司） |  |
| `data.cnt_valid_copyright_s` | Number | 是 | 有效软件著作权数量（包含分子公司） |  |
| `data.patent_valid_ct` | Number | 是 | 有效专利总数（包含分子公司） |  |
| `data.kc_label` | String | 是 | 科创标签 |  |
| `data.emerging_l1` | String | 是 | 所属新兴产业领域 |  |

### 98.85 科创企业综合评分详情

- Hub：`POST /api/v1/data/enterprise/98.85/query`；上游方法 GET；可调用
- 说明：根据企业名称、注册号、统一社会信用代码获取科创企业综合评分详情

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 否 | 返回结果状态 |  |
| `message` | String | 否 | 返回结果消息 |  |
| `sign` | String | 否 | 数据签名 |  |
| `data` | Object | 否 | 数据 |  |
| `data.science_technology_original_scor` | Number | 否 | 企业科创力得分（一级） |  |
| `data.technology_layout_score` | Number | 否 | 技术布局得分（二级） |  |
| `data.cnt_category_num_ipc_score` | Number | 否 | IPC分类数量得分 |  |
| `data.cnt_pct_applications_score` | Number | 否 | PCT申请量得分 |  |
| `data.cnt_industry_research_co_score` | Number | 否 | 产学研合作得分 |  |
| `data.cnt_industry_research_ent_score` | Number | 否 | 产学研合作申请的单位数得分 |  |
| `data.cnt_industry_research_patent_sco` | Number | 否 | 产学研合作申请专利数得分 |  |
| `data.cnt_patent_words_score` | Number | 否 | 技术广度得分（二级） |  |
| `data.cnt_families_num_score` | Number | 否 | 同族专利数量（专利优先权）得分 |  |
| `data.cnt_applicant_co_score` | Number | 否 | 专利联合申请人数量（统计人数）得分 |  |
| `data.cnt_patent_co_score` | Number | 否 | 专利联合申请数量（统计专利个数）得分 |  |
| `data.cnt_req_country_score` | Number | 否 | 专利全球布局（统计布局国家个数）得分 |  |
| `data.technology_value_score` | Number | 否 | 技术价值得分（二级） |  |
| `data.cnt_high_degree_patent_score` | Number | 否 | 高价值专利数量得分 |  |
| `data.ratio_high_degree_patent_score` | Number | 否 | 高价值专利数量占比得分 |  |
| `data.cnt_original_num_score` | Number | 否 | 专利分案子案个数得分 |  |
| `data.avg_patent_value_degree_score` | Number | 否 | 专利价值度平均分得分 |  |
| `data.total_final_patent_amount_w_scor` | Number | 否 | 专利价值总和（元）得分 |  |
| `data.avg_patent_high_value_degree_sco` | Number | 否 | 专利价值top10的平均分得分 |  |
| `data.avg_final_patent_amount_w_score` | Number | 否 | 专利平均价值（元）得分 |  |
| `data.cnt_example_num_score` | Number | 否 | 专利实施例个数得分 |  |
| `data.technology_influence_score` | Number | 否 | 技术影响力得分（二级） |  |
| `data.cnt_high_patent_prc_num_score` | Number | 否 | 高价值专利被引用次数得分 |  |
| `data.avg_high_patent_prc_num_score` | Number | 否 | 高价值专利平均被引用次数得分 |  |
| `data.cnt_patent_prc_num_score` | Number | 否 | 专利被引用次数得分 |  |
| `data.avg_patent_prc_num_score` | Number | 否 | 专利平均被引用次数得分 |  |
| `data.cnt_permit_num_score` | Number | 否 | 专利许可数得分 |  |
| `data.technology_ability_score` | Number | 否 | 研发规模/科创成果/研发能力得分（二级） |  |
| `data.cnt_valid_fmzl_unauthorized_1yr_` | Number | 否 | 近1年有效未授权发明专利数量得分 |  |
| `data.cnt_valid_fmzl_authorized_1yr_sc` | Number | 否 | 近1年有效已授权发明专利数量得分 |  |
| `data.cnt_valid_fmzl_unauthorized_3yrs` | Number | 否 | 近3年有效未授权发明专利数量得分 |  |
| `data.cnt_valid_fmzl_authorized_3yrs_s` | Number | 否 | 近3年有效已授权发明专利数量得分 |  |
| `data.cnt_valid_copyright_s_score` | Number | 否 | 有效软件著作权数量得分 |  |
| `data.cnt_valid_syxx_score` | Number | 否 | 有效实用新型专利数量得分 |  |
| `data.ratio_valid_syxx_score` | Number | 否 | 有效实用新型专利数量占比得分 |  |
| `data.cnt_valid_wgsj_score` | Number | 否 | 有效外观设计专利数量得分 |  |
| `data.cnt_valid_fmzl_unauthorized_scor` | Number | 否 | 有效未授权发明专利数量得分 |  |
| `data.ratio_valid_fmzl_unauthorized_sc` | Number | 否 | 有效未授权发明专利数量占比得分 |  |
| `data.cnt_valid_fmzl_authorized_score` | Number | 否 | 有效已授权发明专利数量得分 |  |
| `data.ratio_valid_fmzl_authorized_scor` | Number | 否 | 有效已授权发明专利数量占比得分 |  |
| `data.cnt_original_transfer_patent_sco` | Number | 否 | 原创专利转移数量得分 |  |
| `data.technology_team_score` | Number | 否 | 研发团队得分（二级） |  |
| `data.cnt_designer_score` | Number | 否 | 发明人规模得分 |  |
| `data.cnt_core_team_score` | Number | 否 | 核心团队人数得分 |  |
| `data.cnt_active_designer_score` | Number | 否 | 活跃发明人规模得分 |  |
| `data.technicist_proportion_score` | Number | 否 | 技术人员规模占比得分 |  |
| `data.research_and_development_bk_scor` | Number | 否 | 研发背景得分（二级） |  |
| `data.if_award_people_score` | Number | 否 | 科技人才情况得分 |  |
| `data.technology_stability_score` | Number | 否 | 研发稳定性得分（二级） |  |
| `data.copyright_s_growth_ratio_score` | Number | 否 | 有效软件著作权增长率得分 |  |
| `data.valid_syxx_growth_ratio_score` | Number | 否 | 有效实用新型专利增长率得分 |  |
| `data.valid_wgsj_growth_ratio_score` | Number | 否 | 有效外观设计专利增长率得分 |  |
| `data.fmzl_unauthorized_growth_ratio_s` | Number | 否 | 有效未授权发明专利增长率得分 |  |
| `data.fmzl_authorized_growth_ratio_sco` | Number | 否 | 有效已授权发明专利增长率得分 |  |
| `data.maintain_cycle_score` | Number | 否 | 高价值专利入局年限得分 |  |
| `data.cnt_patent_rest_yr_score` | Number | 否 | 专利寿命得分 |  |
| `data.technology_efficiency_score` | Number | 否 | 研发效率得分（二级） |  |
| `data.cnt_patents_per_designer_score` | Number | 否 | 人均研发产出效率（专利数量）得分 |  |
| `data.cnt_patents_per_industry_score` | Number | 否 | 行业研发效率（专利数量）对比得分 |  |
| `data.cnt_maintain_cycle_score` | Number | 否 | 技术更新周期-专利维持年限得分 |  |
| `data.patent_request_total_5yr_score` | Number | 否 | 近5年年均专利申请数得分 |  |
| `data.technology_honor_score` | Number | 否 | 科创荣誉/资质得分（二级） |  |
| `data.cnt_kc_label_score` | Number | 否 | 创新资质认定得分 |  |
| `data.if_standard_score` | Number | 否 | 标准制定得分 |  |
| `data.if_rd_organization_score` | Number | 否 | 科研机构和研发平台得分 |  |
| `data.if_ent_honor_score` | Number | 否 | 科创获奖情况得分 |  |
| `data.operating_stability_score` | Number | 否 | 经营稳定性得分（一级） |  |
| `data.ent_background_score` | Number | 否 | 企业背景得分（二级） |  |
| `data.ent_capi_background_score` | Number | 否 | 资本背景得分 |  |
| `data.ent_stock_background_score` | Number | 否 | 上市公司背景得分 |  |
| `data.invest_strength_rating_score` | Number | 否 | 投资机构评级得分 |  |
| `data.ent_scale_score` | Number | 否 | 企业规模得分（二级） |  |
| `data.social_security_include_child_su` | Number | 否 | 人员规模得分 |  |
| `data.ent_regist_capi_score` | Number | 否 | 注册资本得分 |  |
| `data.cnt_sub_ent_score` | Number | 否 | 分子公司数量得分 |  |
| `data.ent_maturity_scale_score` | Number | 否 | 企业成熟度得分（二级） |  |
| `data.operating_yrs_score` | Number | 否 | 经营年限得分 |  |
| `data.life_circle_score` | Number | 否 | 企业生命周期得分 |  |
| `data.operating_ability_score` | Number | 否 | 经营能力得分（一级） |  |
| `data.operating_performance_score` | Number | 否 | 经营业绩得分（二级） |  |
| `data.cnt_quality_supplier_3yr_score` | Number | 否 | 近三年中标优质企业客户数量得分 |  |
| `data.ent_growth_score` | Number | 否 | 企业成长性得分（二级） |  |
| `data.regi_capi_growth_ratio_score` | Number | 否 | 注册资本增长率得分 |  |
| `data.social_security_growth_ratio_sco` | Number | 否 | 参保人数增长率得分 |  |
| `data.branch_growth_cnt_ratio_score` | Number | 否 | 设立分支机构或对外投资或融资次数增长率得分 |  |
| `data.invest_growth_amt_ratio_score` | Number | 否 | 对外投资或融资金额增长率得分 |  |
| `data.ent_honor_score` | Number | 否 | 优质资质荣誉得分（二级） |  |
| `data.if_top_tax_score` | Number | 否 | 纳税百强得分 |  |
| `data.if_tax_a_3yr_score` | Number | 否 | 连续3年A级纳税人得分 |  |
| `data.if_quality_list_score` | Number | 否 | 榜单企业（中国500强/民企百强/上市后备企业）得分 |  |
| `data.finance_ability_score` | Number | 否 | 融资能力得分（二级） |  |
| `data.finance_latest_round_score` | Number | 否 | 最新一次融资轮次得分 |  |
| `data.amount_unite_total_score` | Number | 否 | 融资总金额得分 |  |
| `data.industry_potentiality_score` | Number | 否 | 行业潜力得分（一级） |  |
| `data.capi_trending_score` | Number | 否 | 资本热度得分（二级） |  |
| `data.indus_financing_amount_trends_sc` | Number | 否 | 对应行业投融资趋势_金额得分 |  |
| `data.indus_financing_count_trends_sco` | Number | 否 | 对应行业投融资趋势_次数得分 |  |
| `data.cnt_ent_ipo_score` | Number | 否 | 对应行业启动+成功ipo数得分 |  |
| `data.indus_finance_cnt_1yr_score` | Number | 否 | 行业/产业近一年融资次数得分 |  |
| `data.indus_finance_amt_1yr_score` | Number | 否 | 行业/产业近一年融资金额得分 |  |
| `data.policy_trending_score` | Number | 否 | 政策导向得分（二级） |  |
| `data.if_emerging_industry_score` | Number | 否 | 战略新兴产业/绿色产业领域得分 |  |
| `data.cnt_ent_policy_industry_score` | Number | 否 | 政府资金扶持或项目奖励企业数量得分 |  |
| `data.regional_key_industry_chain_cnt` | Number | 否 | 行业/产业政策规划分析得分 |  |
| `data.indus_patent_cnt_score` | Number | 否 | 行业/产业研发产出分析得分 |  |
| `data.indus_patent_ratio_score` | Number | 否 | 行业/产业研发产出增长率分析得分 |  |
| `data.indus_rdexp_ratio_score` | Number | 否 | 行业/产业研发投入程度得分 |  |
| `data.indus_ystz_ratio_score` | Number | 否 | 行业/产业营业收入同比增长率得分 |  |
| `data.indus_yltz_ratio_score` | Number | 否 | 行业/产业营业利润同比增长率得分 |  |
| `data.operating_risk_score` | Number | 否 | 经营风险得分（一级） |  |
| `data.serious_technical_risk_score` | Number | 否 | 严重科技研发风险得分 |  |
| `data.technical_risk_score` | Number | 否 | 科技研发风险得分 |  |
| `data.credit_risk_rank` | Number | 否 | 信用风险得分（二级） |  |
| `data.ent_huge_credit_risk_score` | Number | 否 | 企业重大信用风险事件得分 |  |
| `data.ent_credit_risk_score` | Number | 否 | 企业信用风险事件得分 |  |
| `data.research_develop_risk_rank` | Number | 否 | 研发风险得分（二级） |  |
| `data.kc_original_score` | Number | 否 | 科创企业综合评分（原始） |  |
| `data.kc_original_level` | String | 否 | 科创企业综合评级（原始） |  |
| `data.kc_adjust_score` | Number | 否 | 科创企业综合评分（调整后） |  |
| `data.kc_adjust_level` | String | 否 | 科创企业综合评级 |  |

### 65.48 科创企业综合评分模型指标

- Hub：`POST /api/v1/data/enterprise/65.48/query`；上游方法 GET；可调用
- 说明：根据企业名称、注册号、统一社会信用代码获取科创企业综合评分模型指标

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 数据 |  |
| `data.science_technology_original_scor` | Number | 是 | 企业科创力得分 |  |
| `data.technology_layout_score` | Number | 是 | 技术布局得分 |  |
| `data.cnt_category_num_ipc` | Number | 是 | IPC分类数量 |  |
| `data.cnt_pct_applications` | Number | 是 | PCT申请量 |  |
| `data.cnt_industry_research_co` | Number | 是 | 产学研合作 |  |
| `data.cnt_industry_research_ent` | Number | 是 | 产学研合作申请的单位数 |  |
| `data.cnt_industry_research_patent` | Number | 是 | 产学研合作申请专利数 |  |
| `data.cnt_patent_words` | Number | 是 | 技术广度 |  |
| `data.cnt_families_num` | Number | 是 | 同族专利数量（专利优先权） |  |
| `data.cnt_applicant_co` | Number | 是 | 专利联合申请人数量（统计人数） |  |
| `data.cnt_patent_co` | Number | 是 | 专利联合申请数量（统计专利个数） |  |
| `data.cnt_req_country` | Number | 是 | 专利全球布局（统计布局国家个数） |  |
| `data.technology_value_score` | Number | 是 | 技术价值得分 |  |
| `data.cnt_high_degree_patent` | Number | 是 | 高价值专利数量 |  |
| `data.ratio_high_degree_patent` | Number | 是 | 高价值专利数量占比 |  |
| `data.cnt_original_num` | Number | 是 | 专利分案子案个数 |  |
| `data.avg_patent_value_degree` | Number | 是 | 专利价值度平均分 |  |
| `data.total_final_patent_amount_w` | Number | 是 | 专利价值总和（元） |  |
| `data.avg_patent_high_value_degree` | Number | 是 | 专利价值top10的平均分 |  |
| `data.avg_final_patent_amount_w` | Number | 是 | 专利平均价值（元） |  |
| `data.cnt_example_num` | Number | 是 | 专利实施例个数 |  |
| `data.technology_influence_score` | Number | 是 | 技术影响力得分 |  |
| `data.cnt_high_patent_prc_num` | Number | 是 | 高价值专利被引用次数 |  |
| `data.avg_high_patent_prc_num` | Number | 是 | 高价值专利平均被引用次数 |  |
| `data.cnt_patent_prc_num` | Number | 是 | 专利被引用次数 |  |
| `data.avg_patent_prc_num` | Number | 是 | 专利平均被引用次数 |  |
| `data.cnt_permit_num` | Number | 是 | 专利许可数 |  |
| `data.technology_ability_score` | Number | 是 | 研发规模/科创成果/研发能力得分 |  |
| `data.cnt_valid_fmzl_unauthorized_1yr` | Number | 是 | 近1年有效未授权发明专利数量 |  |
| `data.cnt_valid_fmzl_authorized_1yr` | Number | 是 | 近1年有效已授权发明专利数量 |  |
| `data.cnt_valid_fmzl_unauthorized_3yrs` | Number | 是 | 近3年有效未授权发明专利数量 |  |
| `data.cnt_valid_fmzl_authorized_3yrs` | Number | 是 | 近3年有效已授权发明专利数量 |  |
| `data.cnt_valid_copyright_s` | Number | 是 | 有效软件著作权数量 |  |
| `data.cnt_valid_syxx` | Number | 是 | 有效实用新型专利数量 |  |
| `data.ratio_valid_syxx` | Number | 是 | 有效实用新型专利数量占比 |  |
| `data.cnt_valid_wgsj` | Number | 是 | 有效外观设计专利数量 |  |
| `data.cnt_valid_fmzl_unauthorized` | Number | 是 | 有效未授权发明专利数量 |  |
| `data.ratio_valid_fmzl_unauthorized` | Number | 是 | 有效未授权发明专利数量占比 |  |
| `data.cnt_valid_fmzl_authorized` | Number | 是 | 有效已授权发明专利数量 |  |
| `data.ratio_valid_fmzl_authorized` | Number | 是 | 有效已授权发明专利数量占比 |  |
| `data.cnt_original_transfer_patent` | Number | 是 | 原创专利转移数量 |  |
| `data.technology_team_score` | Number | 是 | 研发团队得分 |  |
| `data.cnt_designer` | Number | 是 | 发明人规模 |  |
| `data.cnt_core_team` | Number | 是 | 核心团队人数 |  |
| `data.cnt_active_designer` | Number | 是 | 活跃发明人规模 |  |
| `data.technicist_proportion` | Number | 是 | 技术人员规模占比 |  |
| `data.research_and_development_bk` | String | 是 | 研发背景 |  |
| `data.if_award_people` | Number | 是 | 科技人才情况 |  |
| `data.technology_stability_score` | Number | 是 | 研发稳定性得分 |  |
| `data.copyright_s_growth_ratio` | Number | 是 | 有效软件著作权增长率 |  |
| `data.valid_syxx_growth_ratio` | Number | 是 | 有效实用新型专利增长率 |  |
| `data.valid_wgsj_growth_ratio` | Number | 是 | 有效外观设计专利增长率 |  |
| `data.fmzl_unauthorized_growth_ratio` | Number | 是 | 有效未授权发明专利增长率 |  |
| `data.fmzl_authorized_growth_ratio` | Number | 是 | 有效已授权发明专利增长率 |  |
| `data.maintain_cycle` | Number | 是 | 高价值专利入局年限 |  |
| `data.cnt_patent_rest_yr` | Number | 是 | 专利寿命 |  |
| `data.technology_efficiency_score` | Number | 是 | 研发效率得分 |  |
| `data.cnt_patents_per_designer` | Number | 是 | 人均研发产出效率（专利数量） |  |
| `data.cnt_patents_per_industry` | Number | 是 | 行业研发效率（专利数量）对比 |  |
| `data.cnt_maintain_cycle` | Number | 是 | 技术更新周期-专利维持年限 |  |
| `data.patent_request_total_5yr` | Number | 是 | 近5年年均专利申请数 |  |
| `data.technology_honor_score` | Number | 是 | 科创荣誉/资质得分 |  |
| `data.cnt_kc_label` | String | 是 | 创新资质认定 |  |
| `data.if_standard` | String | 是 | 标准制定 |  |
| `data.if_rd_organization` | String | 是 | 科研机构和研发平台 |  |
| `data.if_ent_honor` | String | 是 | 科创获奖情况 |  |
| `data.operating_stability_score` | Number | 是 | 经营稳定性得分 |  |
| `data.ent_background_score` | Number | 是 | 企业背景得分 |  |
| `data.ent_capi_background` | String | 是 | 资本背景 |  |
| `data.ent_stock_background` | String | 是 | 上市公司背景 |  |
| `data.invest_strength_rating` | String | 是 | 投资机构评级 |  |
| `data.ent_scale_score` | Number | 是 | 企业规模得分 |  |
| `data.ent_regist_capi` | Number | 是 | 注册资本 |  |
| `data.social_security_include_child_su` | Number | 是 | 人员规模 |  |
| `data.cnt_sub_ent` | Number | 是 | 分子公司数量 |  |
| `data.ent_maturity_scale_score` | Number | 是 | 企业成熟度得分 |  |
| `data.operating_yrs` | Number | 是 | 经营年限 |  |
| `data.life_circle` | String | 是 | 企业生命周期 |  |
| `data.operating_ability_score` | Number | 是 | 经营能力得分 |  |
| `data.operating_performance_score` | Number | 是 | 经营业绩得分 |  |
| `data.cnt_quality_supplier_3yr` | Number | 是 | 近三年中标优质企业客户数量 |  |
| `data.ent_growth_score` | Number | 是 | 企业成长性得分 |  |
| `data.regi_capi_growth_ratio` | Number | 是 | 注册资本增长率 |  |
| `data.social_security_growth_ratio` | Number | 是 | 参保人数增长率 |  |
| `data.branch_growth_cnt_ratio` | Number | 是 | 设立分支机构或对外投资或融资次数增长率 |  |
| `data.invest_growth_amt_ratio` | Number | 是 | 对外投资或融资金额增长率 |  |
| `data.ent_honor_score` | Number | 是 | 优质资质荣誉得分 |  |
| `data.if_top_tax` | String | 是 | 纳税百强 |  |
| `data.if_tax_a_3yr` | String | 是 | 连续3年A级纳税人 |  |
| `data.if_quality_list` | String | 是 | 榜单企业（中国500强/民企百强/上市后备企业） |  |
| `data.finance_ability_score` | Number | 是 | 融资能力得分 |  |
| `data.finance_latest_round` | String | 是 | 最新一次融资轮次 |  |
| `data.amount_unite_total` | Number | 是 | 融资总金额 |  |
| `data.industry_potentiality_score` | Number | 是 | 行业潜力得分 |  |
| `data.capi_trending_score` | Number | 是 | 资本热度得分 |  |
| `data.indus_financing_amount_trends` | Number | 是 | 对应行业投融资趋势_金额 |  |
| `data.indus_financing_count_trends` | Number | 是 | 对应行业投融资趋势_次数 |  |
| `data.cnt_ent_ipo` | Number | 是 | 对应行业启动+成功ipo数 |  |
| `data.indus_finance_cnt_1yr` | Number | 是 | 行业/产业近一年融资次数 |  |
| `data.indus_finance_amt_1yr` | Number | 是 | 行业/产业近一年融资金额 |  |
| `data.policy_trending_score` | Number | 是 | 政策导向得分 |  |
| `data.if_emerging_industry` | String | 是 | 战略新兴产业/绿色产业领域 |  |
| `data.cnt_ent_policy_industry` | Number | 是 | 政府资金扶持或项目奖励企业数量 |  |
| `data.regional_key_industry_chain_cnt` | Number | 是 | 行业/产业政策规划分析 |  |
| `data.indus_patent_cnt` | Number | 是 | 行业/产业研发产出分析 |  |
| `data.indus_patent_ratio` | Number | 是 | 行业/产业研发产出增长率分析 |  |
| `data.indus_rdexp_ratio` | Number | 是 | 行业/产业研发投入程度 |  |
| `data.indus_ystz_ratio` | Number | 是 | 行业/产业营业收入同比增长率 |  |
| `data.indus_yltz_ratio` | Number | 是 | 行业/产业营业利润同比增长率 |  |
| `data.operating_risk_score` | Number | 是 | 经营风险得分 |  |
| `data.research_develop_risk_rank` | Number | 是 | 研发风险得分 |  |
| `data.serious_technical_risk` | String | 是 | 严重科技研发风险 |  |
| `data.technical_risk` | String | 是 | 科技研发风险 |  |
| `data.credit_risk_rank` | Number | 是 | 信用风险得分 |  |
| `data.ent_huge_credit_risk` | String | 是 | 企业重大信用风险事件 |  |
| `data.ent_credit_risk` | String | 是 | 企业信用风险事件 |  |
| `data.kc_original_score` | Number | 是 | 科创企业综合评分（原始） |  |
| `data.kc_original_level` | String | 是 | 科创企业综合评级（原始） |  |
| `data.kc_adjust_score` | Number | 是 | 科创企业综合评分（调整后） |  |
| `data.kc_adjust_level` | String | 是 | 科创企业综合评级（调整后） |  |

### 72.51 综合风险分

- Hub：`POST /api/v1/data/enterprise/72.51/query`；上游方法 GET；**不可调用**（无公开价，返回 403 `enterprise_price_negotiated`）
- 说明：获取企业的综合风险评分。企业综合风险评分是从信用风险、不可抗力风险、合规风险、应收账款风险、内部治理风、经营风险、对外投资风险7个大类（共28个细分维度）对企业风险水平进行综合评价，得到用于表征企业当前风险状态的评分体系。综合风险评分总分100分，共6个等级。分值越高，代表企业当前存在的风险越多，未来合作的稳定性也越差。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `ename` | string | 否 | 企业名称 |  |
| `eid` | string | 否 | 企业ID |  |
| `industry_code_l2` | string | 否 | 国标二级行业代码 |  |
| `industry_score_0101` | string | 否 | 高层人事变动得分 |  |
| `industry_score_0102` | string | 否 | 股东减持或退出得分 |  |
| `industry_score_0103` | string | 否 | 实控人变更得分 |  |
| `industry_score_0104` | string | 否 | 人员规模缩减得分 |  |
| `industry_score_0201` | string | 否 | 投资企业疑似退出市场得分 |  |
| `industry_score_0202` | string | 否 | 投资企业出现债务危机得分 |  |
| `industry_score_0203` | string | 否 | 投资企业受到监管处罚得分 |  |
| `industry_score_0204` | string | 否 | 投资企业经营行为异常得分 |  |
| `industry_score_0205` | string | 否 | 投资企业纳税行为异常得分 |  |
| `industry_score_0301` | string | 否 | 疑似或实际发生违约得分 |  |
| `industry_score_0302` | string | 否 | 财产和行为被限制得分 |  |
| `industry_score_0303` | string | 否 | 拒绝或无能力偿还债务得分 |  |
| `industry_score_0401` | string | 否 | 疑似或实际被违约得分 |  |
| `industry_score_0402` | string | 否 | 债务可能面临损失得分 |  |
| `industry_score_0501` | string | 否 | 虚假经营嫌疑得分 |  |
| `industry_score_0502` | string | 否 | 流动资金不足得分 |  |
| `industry_score_0503` | string | 否 | 生产质量或进度问题得分 |  |
| `industry_score_0504` | string | 否 | 当前或预期业绩不佳得分 |  |
| `industry_score_0505` | string | 否 | 供应商疑似断供得分 |  |
| `industry_score_0506` | string | 否 | 疑似退出市场得分 |  |
| `industry_score_0601` | string | 否 | 监管关注和处罚得分 |  |
| `industry_score_0602` | string | 否 | 市场抽查结果异常得分 |  |
| `industry_score_0603` | string | 否 | 经营行为异常得分 |  |
| `industry_score_0604` | string | 否 | 纳税行为异常得分 |  |
| `industry_score_0701` | string | 否 | 社会异常事件得分 |  |
| `industry_score_0702` | string | 否 | 公共卫生事件得分 |  |
| `industry_score_0703` | string | 否 | 自然灾害得分 |  |
| `industry_score_0704` | string | 否 | 行业风险得分 |  |
| `composite_risk_score` | string | 否 | 综合风险评分 |  |
| `composite_risk_rating` | string | 否 | 综合风险等级 |  |
| `ename` | String | 是 |  |  |

## 企业标签


### 82.11 概念标签

- Hub：`POST /api/v1/data/enterprise/82.11/query`；上游方法 GET；可调用
- 说明：通过企业企业全名/统一社会信用代码，获取企业的标签列表，包括但不限于高新企业、互联网、外贸企业、金融科技、被执行人等标签

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Array | 是 | 返回查询结果，如果没有匹配记录则返回为空。 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 79.14 科技型企业

- Hub：`POST /api/v1/data/enterprise/79.14/query`；上游方法 GET；可调用
- 说明：根据企业全名/注册号/统一社会信用代码、科技型企业类型、发布单位的行政类别、认定年份、认定状态等获得科技型企业的相关信息。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |
| `type_code` | String | 否 | 科技型类型代码（默认全部），入参值参照枚举 |
| `level_code` | String | 否 | 行政级别代码（默认全部），入参值参照枚举 |
| `state_code` | String | 否 | 状态代码（默认全部），入参值参照枚举 |
| `year` | Number | 否 | 认定年份（默认全部） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 科技类型清单 |  |
| `data.items[].valid_start` | String | 是 | 有效期起始日期 |  |
| `data.items[].valid_end` | String | 是 | 有效期终止日期 |  |
| `data.items[].year` | Number | 是 | 认定年份 |  |
| `data.items[].level` | String | 是 | 行政级别 |  |
| `data.items[].end_date` | String | 是 | 终止/撤销日期 |  |
| `data.items[].state` | String | 是 | 认定状态 |  |
| `data.items[].number` | String | 是 | 编码 |  |
| `data.items[].pub_department` | String | 是 | 发布机关 |  |
| `data.items[].type` | String | 是 | 科技类型 |  |
| `data.items[].attachment_url` | String | 是 | 附件链接 | 🔗 |
| `data.items[].attachment_name` | String | 是 | 附件名称 |  |
| `data.items[].public_status` | String | 是 | 网站公示状态 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 82.10 企业特点（初创企业）

- Hub：`POST /api/v1/data/enterprise/82.10/query`；上游方法 GET；可调用
- 说明：根据企业名称返回该企业特点，如该企业是否为初创企业

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.start_up` | Number | 是 | 初创企业（0：否；1：是） |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 82.12 企业信息标签

- Hub：`POST /api/v1/data/enterprise/82.12/query`；上游方法 GET；可调用
- 说明：通过企业名称获取企业信息标签

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业名称关键字/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Array | 是 | 返回查询结果 YYYY返回值为返回年份获得的纳税A级评 级年份，如果‘2022’，为该企业 2022 年纳税 A 级 返回标签类型：A 级纳税人标签，融资轮 次标签，集团标签 |  |

### 1.25 主营业务

- Hub：`POST /api/v1/data/enterprise/1.25/query`；上游方法 GET；可调用
- 说明：企业主营业务画像

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Array | 是 | 返回查询结果，如果没有匹配记录则返回空。 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 44.82 概念标签V2

- Hub：`POST /api/v1/data/enterprise/44.82/query`；上游方法 GET；可调用
- 说明：通过企业企业全名/统一社会信用代码，获取企业的标签列表，包括但不限于高新企业、互联网、外贸企业、金融科技、被执行人等标签

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `type_id` | String | 否 | 概念标签类型id, 支持多个输入，多个输入用，分隔。以下为type_id和type_name枚举： 001 业务概念 002 榜单企业 003 企业类型 004 企业特点 005 生物医药 006 规上企业 007 高成长企业 008 企业规模 009 自贸区 010 区域类型 011 风险特征 012 资金扩张 013 业务扩张 014 人员扩张 015 技术领先 016 地域扩张 101 上市信息 102 司法涉诉 104 企业性质 105 组织机构 106 金融机构 107 供应商企业 108 政府扶持和奖励 201 科技认定 202 建筑工程类认证 203 环保类认证 204 医疗器械类认证 205 药品类认证 206 国家推行的工业产品认证 207 食品农产品认证 208 其他资质认证 209 化妆品类认证 210 管理体系认证 211 服务认证 212 电子信息类认证 213 自然资源相关认证 215 绿色认证 216 外贸型企业 217 科技奖项 218 研发成果 219 优质个体户 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，具体字段 含义见下表 |  |
| `data.items` | Array | 是 | 无（原表未填） |  |
| `data.items[].type_id` | String | 是 | 概念标签类型 id |  |
| `data.items[].type_name` | String | 是 | 概念标签类型 |  |
| `data.items[].tags` | Array | 是 | 概念标签信息 |  |
| `data.items[].tags[].tag_id` | String | 是 | 概念标签 id |  |
| `data.items[].tags[].tag_name` | String | 是 | 概念标签 |  |

### 89.95 地区认定标签

- Hub：`POST /api/v1/data/enterprise/89.95/query`；上游方法 GET；可调用
- 说明：用于金融机构涉农业务中企业所属地区的判定

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.type_code` | String | 是 | 企业类型代码 |  |
| `data.type_name` | String | 是 | 企业地区类型 |  |

## 新闻舆情


### 10.1 新闻列表

- Hub：`POST /api/v1/data/enterprise/10.1/query`；上游方法 GET；可调用
- 说明：企业新闻列表，包括新闻来源、情感属性、舆情标签、负面指数等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为 0） |
| `tag_list` | String | 否 | 舆情分类，参考数据字典tag_list字段，数组字符串，示例：["131","132"] |
| `sentiment` | String | 否 | 新闻本身情感属性（新闻是正面还是负面），参考数据字典sentiment字段，数组字符串，示例：["neg","pos"] |
| `company_sentiment` | String | 否 | 企业的情感属性（企业在新闻中是正面还是负面），参考数据字典sentiment字段，数组字符串，示例：["neg","pos"] |
| `class_types` | String | 否 | 新闻类别，全部可不传，参考数据字典class_types字段，数组字符串，示例：["news"] |
| `new_tag_list` | String | 否 | 事件分类，参考数据字典new_tag_list字段，数组字符串，示例：["0902001","0202016"] |
| `company_new_tag` | String | 否 | 企业的事件分类，参考数据字典new_tag_list字段，数组字符串，示例：["0102004","0102005"] |
| `create_time_range` | String | 否 | 舆情发布时间范围，数组字符串，示例：["2019-01-01","2019-08-14"] |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `data` | Object | 是 | 返回查询结果，每次调用返回 20 条记录， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 企业新闻信息列表 |  |
| `data.items[].title` | String | 是 | 标题 |  |
| `data.items[].time` | String | 是 | 发布日期 |  |
| `data.items[].content` | String | 是 | 简介 |  |
| `data.items[].source` | String | 是 | 来源 |  |
| `data.items[].url` | String | 是 | 原文链接 | 🔗 |
| `data.items[].sentiment` | String | 是 | 情感属性 |  |
| `data.items[].tag` | String | 是 | 舆情标签，已弃用，请用new_tag_list替代 |  |
| `data.items[].oid` | String | 是 | 文章 id |  |
| `data.items[].neg_index` | String | 是 | 负面指数 |  |
| `data.items[].company_sentiment` | String | 是 | 企业的新闻情感 |  |
| `data.items[].company_new_tag` | Array | 是 | 企业的新闻标签 |  |
| `data.items[].new_tag_list` | Array | 是 | 事件分类 |  |
| `data.items[].ali_name` | String | 是 | 关键词 |  |
| `data.items[].class_type` | String | 是 | 新闻分类 |  |
| `data.items[].rank` | String | 是 | 新闻来源等级 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 10.4 新闻详细信息

- Hub：`POST /api/v1/data/enterprise/10.4/query`；上游方法 GET（可选 GET/POST）；可调用
- 说明：新闻舆情详情信息，包括标题、发布日期、内容、来源、原文链接、情感属性、舆情标签等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `oid` | String | 是 | 文章id |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.time` | String | 是 | 发布日期 |  |
| `data.title` | String | 是 | 标题 |  |
| `data.source` | String | 是 | 来源 |  |
| `data.url` | String | 是 | 原文链接 | 🔗 |
| `data.tag` | String | 是 | 舆情标签 |  |
| `data.sentiment` | String | 是 | 情感属性（不维护） |  |
| `data.detail` | String | 是 | 内容（关于黑猫投诉、消费保的详情内容存在数组ison：status：状态 time：时间 content：内容） |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

## 企业发展


### 37.3 融资信息

- Hub：`POST /api/v1/data/enterprise/37.3/query`；上游方法 GET；可调用
- 说明：企业融资信息，包括企业名称、融资金额、轮次、日期和投资机构等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.financing_list` | Array | 是 | 融资信息 |  |
| `data.financing_list[].finance_date` | String | 是 | 融资日期 |  |
| `data.financing_list[].financing_round` | String | 是 | 融资轮次 |  |
| `data.financing_list[].financing_amount` | String | 是 | 融资金额 |  |
| `data.financing_list[].investors` | Array | 是 | 投资机构信息 |  |
| `data.financing_list[].investors[].org_name` | String | 是 | 投资机构名称 |  |
| `data.financing_list[].investors[].org_id` | String | 是 | 投资机构 Id |  |
| `data.financing_list[].news` | Array | 是 | 融资新闻信息 |  |
| `data.financing_list[].news[].title` | String | 是 | 融资新闻标题 |  |
| `data.financing_list[].news[].url` | String | 是 | 融资新闻 URL | 🔗 |
| `data.id` | String | 是 | 企业Id |  |
| `data.company_size` | String | 是 | 企业规模 |  |
| `data.company_abbreviation` | String | 是 | 企业简称 |  |
| `data.company_desc` | String | 是 | 企业简介 |  |
| `data.company` | String | 是 | 企业名称 |  |
| `data.operate_status` | String | 是 | 运营状态 |  |
| `data.company_url` | String | 是 | 网站 | 🔗 |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 50.5 核心团队

- Hub：`POST /api/v1/data/enterprise/50.5/query`；上游方法 GET；可调用
- 说明：企业核心团队信息，包括姓名、职位、教育经历和工作经历等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 企业核心团队信息列表 |  |
| `data.items[].logo` | String | 是 | 头像 | 🔗 |
| `data.items[].education` | String | 是 | 教育背景 |  |
| `data.items[].brief` | String | 是 | 简介 |  |
| `data.items[].position` | String | 是 | 职位 |  |
| `data.items[].work` | String | 是 | 工作经历 |  |
| `data.items[].name` | String | 是 | 姓名 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 49.5 产品信息

- Hub：`POST /api/v1/data/enterprise/49.5/query`；上游方法 GET；可调用
- 说明：企业产品信息，包括项目名称、logo链接、项目地址、运营状态等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 企业产品信息列表 |  |
| `data.items[].logo` | String | 是 | logo链接 | 🔗 |
| `data.items[].website` | String | 是 | 项目地址 | 🔗 |
| `data.items[].brief` | String | 是 | 简介 |  |
| `data.items[].name` | String | 是 | 产品名称 |  |
| `data.items[].status` | String | 是 | 运营状态 |  |
| `data.items[].intro` | String | 是 | 介绍 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 48.1 竞品信息

- Hub：`POST /api/v1/data/enterprise/48.1/query`；上游方法 GET；可调用
- 说明：企业竞品信息，包括竞品名称、所属企业、竞品简介等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 企业竞品信息列表 |  |
| `data.items[].logo` | String | 是 | 竞品logo | 🔗 |
| `data.items[].sim_eid` | String | 是 | 竞品所属企业id |  |
| `data.items[].ename` | String | 是 | 竞品所属企业 |  |
| `data.items[].name` | String | 是 | 竞品名称 |  |
| `data.items[].category` | String | 是 | 竞品类别 |  |
| `data.items[].eid` | String | 是 | 企业id |  |
| `data.items[].date` | String | 是 | 竞品成立时间 |  |
| `data.items[].operate_status` | String | 是 | 竞品运营状态 |  |
| `data.items[].brief` | String | 是 | 竞品简介 |  |
| `data.items[].round` | String | 是 | 竞品轮次 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 66.28 投资机构与投资项目查询

- Hub：`POST /api/v1/data/enterprise/66.28/query`；上游方法 GET；可调用
- 说明：通过机构名称查询投资机构的对外投资项目信息，主要支持风险投资机构的查询。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 机构名称，示例：曦域资本 |
| `source` | String | 否 | 是否为公开投资项目。1-公开（新闻）； 0-非公开（工商变更） |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.logo` | String | 是 | 企业logo | 🔗 |
| `data.website` | String | 是 | 网址 | 🔗 |
| `data.items` | Array | 是 | 返回列表中记录总数 |  |
| `data.items[].round` | String | 是 | 融资轮次 |  |
| `data.items[].u_tags` | String | 是 | 是否隐藏 |  |
| `data.items[].round_date` | String | 是 | 投资日期 |  |
| `data.items[].ename` | String | 是 | 被投资企业名称 |  |
| `data.items[].amount` | String | 是 | 投资金额 |  |
| `data.items[].currency` | String | 是 | 币种。人名币CNY；美元USD；港元HKD；欧元EUR；英镑GBP；日元JPY；新加坡元SGD；港元AUD；印度卢比INR |  |
| `data.items[].org_source` | String | 是 | 是否为公开投资项目 |  |
| `data.items[].funding_status` | String | 是 | 融资状态。空-默认为完成；114010-拟；114020-进行中；114030-已完成；114040-终止；114050-失败 |  |
| `data.invest_name` | String | 是 | 企业简称 |  |
| `data.establish_date` | String | 是 | 成立日期 |  |
| `data.description` | String | 是 | 企业简介 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.location` | String | 是 | 地区 |  |
| `data.invest_id` | String | 是 | 投资编号 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 79.39 企业所属产业链环节

- Hub：`POST /api/v1/data/enterprise/79.39/query`；上游方法 GET（可选 GET/POST）；**不可调用**（无公开价，返回 403 `enterprise_price_negotiated`）
- 说明：企业所属产业链详情信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].chain_name` | String | 是 | 所属产业链 |  |
| `data.items[].chain_status` | String | 是 | 产业链上中下游 |  |
| `data.items[].product_name` | String | 是 | 产品名称 |  |
| `data.items[].product_category` | String | 是 | 产品分类 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |
| `sign` | string | 是 | 数据签名 |  |
| `message` | string | 是 | 返回结果消息 |  |

### 83.58 战略新兴产业

- Hub：`POST /api/v1/data/enterprise/83.58/query`；上游方法 GET；可调用
- 说明：根据企业名称获取所在战略新兴产业

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.region_code` | String | 是 | 最优区域码 |  |
| `data.region_name` | String | 是 | 最优区域名称 |  |
| `data.province_code` | String | 是 | 省份code |  |
| `data.province_name` | String | 是 | 省份名称 |  |
| `data.city_code` | String | 是 | 城市code |  |
| `data.city_name` | String | 是 | 城市名称 |  |
| `data.gd_longitude` | Number | 是 | 经度 |  |
| `data.gd_latitude` | Number | 是 | 纬度 |  |
| `data.start_date` | String | 是 | 企业注册日期 |  |
| `data.regist_capi` | String | 是 | 注册资本 |  |
| `data.industry_code` | String | 是 | 企业行业代码 |  |
| `data.econ_kind` | String | 是 | 企业类别 |  |
| `data.enterprise_standard_status` | String | 是 | 企业存续状态 |  |
| `data.credit_no` | String | 是 | 企业统一社会信用代码 |  |
| `data.items` | Array | 是 | 战略新兴产业列表 |  |
| `data.items[].emerging_industry_l1_code` | String | 是 | 战新产业一级code |  |
| `data.items[].emerging_industry_l1_name` | String | 是 | 战新产业一级名称 |  |
| `data.items[].emerging_industry_l2_code` | String | 是 | 战新产业二级code |  |
| `data.items[].emerging_industry_l2_name` | String | 是 | 战新产业二级名称 |  |
| `data.items[].emerging_industry_l3_code` | String | 是 | 战新产业三级code |  |
| `data.items[].emerging_industry_l3_name` | String | 是 | 战新产业三级名称 |  |
| `data.items[].emerging_industry_l4_code` | String | 是 | 战新产业四级code |  |
| `data.items[].emerging_industry_l4_name` | String | 是 | 战新产业四级名称 |  |
| `data.items[].emerging_industry_conn_code` | String | 是 | 战新产业code组合 |  |
| `data.items[].emerging_industry_conn_name` | String | 是 | 战新产业名称组合 |  |
| `data.items[].finest_level` | Number | 是 | 末级产业级数 |  |
| `data.items[].correlation_degree` | Number | 是 | 产业-公司关联度 |  |
| `data.items[].emerging_industry_l1_ecount` | String | 是 | 一级产业企业统计 |  |
| `data.items[].emerging_industry_l2_ecount` | String | 是 | 二级产业企业统计 |  |
| `data.items[].emerging_industry_l3_ecount` | String | 是 | 三级产业企业统计 |  |
| `data.items[].emerging_industry_l4_ecount` | String | 是 | 四级产业企业统计 |  |

## 客商关系


### 77.1 企业供应商信息

- Hub：`POST /api/v1/data/enterprise/77.1/query`；上游方法 GET；可调用
- 说明：企业供应商信息，包括供应商企业名称、地址区域代码、报告日期等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.item` | Array | 是 | 供应商信息列表 |  |
| `data.item[].related_eid` | String | 是 | 供应商企业eid |  |
| `data.item[].eid` | String | 是 | 企业eid |  |
| `data.item[].related_ename` | String | 是 | 供应商企业名称 |  |
| `data.item[].address_code` | String | 是 | 地址区域代码 |  |
| `data.item[].report_date` | String | 是 | 报告日期 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 77.2 企业客户信息

- Hub：`POST /api/v1/data/enterprise/77.2/query`；上游方法 GET；可调用
- 说明：企业客户信息，包括客户企业名称、地址区域代码、报告日期等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.item` | Array | 是 | 客户信息列表 |  |
| `data.item[].related_eid` | String | 是 | 客户企业eid |  |
| `data.item[].eid` | String | 是 | 企业eid |  |
| `data.item[].related_ename` | String | 是 | 客户企业名称 |  |
| `data.item[].address_code` | String | 是 | 地址区域代码 |  |
| `data.item[].report_date` | String | 是 | 报告日期 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 79.41 供应链上下游查询

- Hub：`POST /api/v1/data/enterprise/79.41/query`；上游方法 GET；可调用
- 说明：通过企业名称获取企业的供应链上下游信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |
| `relationship_code` | Number | 否 | 关联方关系（默认返回全部） 1甲方、2乙方、3合作 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 企业列表 |  |
| `data.items[].relationship` | string | 是 | 合作方角色。包含甲方、乙方、合作三种角色关系 |  |
| `data.items[].trade_amount` | Number | 是 | 交易金额 |  |
| `data.items[].trade_percent` | Number | 是 | 交易占比 |  |
| `data.items[].related_ename` | string | 是 | 合作方名称 |  |
| `data.items[].sub_ename` | string | 是 | 子公司名称 |  |
| `data.items[].report_date` | string | 是 | 事件日期 |  |
| `data.items[].source` | String | 是 | 数据来源：1中标公告、2企业年报、3合同纠纷案件、4新闻舆情、5舆情（算法）、6人工采集 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

## 集团信息


### 31.29 集团成员

- Hub：`POST /api/v1/data/enterprise/31.29/query`；上游方法 GET；可调用
- 说明：集团成员信息，包括集团名称、集团企业数，以及集团成员信息，包括名称、法人、注册资本等，不支持香港企业查询

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，一页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.groupId` | String | 是 | 集团id |  |
| `data.groupName` | String | 是 | 集团名称 |  |
| `data.name` | String | 是 | 被查询企业名称 |  |
| `data.groupRegCapi` | Number | 是 | 集团注册资本（万） |  |
| `data.mainCompanyName` | String | 是 | 主企业名称 |  |
| `data.total` | Number | 是 | 集团成员企业总数 |  |
| `data.items` | Array | 是 | 集团成员企业列表 |  |
| `data.items[].id` | String | 是 | 成员企业id |  |
| `data.items[].name` | String | 是 | 成员企业名称 |  |
| `data.items[].startDate` | String | 是 | 成立日期 |  |
| `data.items[].operName` | String | 是 | 成员企业法定代表人 |  |
| `data.items[].creditNo` | String | 是 | 成员企业统一社会信用代码 |  |
| `data.items[].status` | String | 是 | 成员企业状态 |  |
| `data.items[].regCapiNum` | String | 是 | 成员企业注册资本（万） |  |
| `data.items[].regCapiCurrency` | String | 是 | 成员企业注册资本货币 |  |
| `data.items[].acTotalPercent` | String | 是 | 实控人对集团成员的持股比例 |  |
| `data.items[].corpTotalPercent` | String | 是 | 主公司对当前企业综合持股 |  |
| `data.items[].acLevel` | String | 是 | 从实控人到当前企业最短路径层级 |  |
| `data.items[].corpLevel` | String | 是 | 从主公司到当前企业最短路径层级 |  |

### 83.2 集团对外投资信息

- Hub：`POST /api/v1/data/enterprise/83.2/query`；上游方法 GET；可调用
- 说明：集团对外投资信息，包括集团名称、集团对外投资企业数，以及集团对外投资企业信息，包括企业名称、企业类型、被投资总额等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.Name` | String | 是 | 主企业名称 |  |
| `data.id` | String | 是 | 企业ID |  |
| `data.group_name` | String | 是 | 集团名称 |  |
| `data.name` | String | 是 | 企业名称 |  |
| `data.items` | Array | 是 | 对外投资企业列表 |  |
| `data.items[].id` | String | 是 | 被投资企业id |  |
| `data.items[].shareholder` | String | 是 | 被投资企业集团内投资方 |  |
| `data.items[].shareholder.percent` | String | 是 | 投资比例 |  |
| `data.items[].shareholder.stock_num` | String | 是 | 股份数量 |  |
| `data.items[].shareholder.con_date` | String | 是 | 出资日期 |  |
| `data.items[].shareholder.eid` | String | 是 | 投资企业 id |  |
| `data.items[].shareholder.name` | String | 是 | 投资企业名称 |  |
| `data.items[].total_amount` | Number | 是 | 被投资总额 |  |
| `data.items[].name` | String | 是 | 被投资企业名称 |  |
| `data.items[].type` | String | 是 | 被投资企业类型 |  |
| `data.group_number` | Number | 是 | 对外投资总数 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 83.3 集团投资方信息

- Hub：`POST /api/v1/data/enterprise/83.3/query`；上游方法 GET；可调用
- 说明：集团投资方信息，包括集团名称、集团投资方总数，以及集团投资方信息，包括投资方名称、类型、总投资金额等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.Name` | String | 是 | 主企业名称 |  |
| `data.id` | String | 是 | 企业ID |  |
| `data.group_name` | String | 是 | 集团名称 |  |
| `data.name` | String | 是 | 企业名称 |  |
| `data.items` | Array | 是 | 投资方企业列表 |  |
| `data.items[].invest` | String | 是 | 投资方投资集团内企业 |  |
| `data.items[].invest.percent` | String | 是 | 投资比例 |  |
| `data.items[].invest.eid` | String | 是 | 投资方投资集团内企业id |  |
| `data.items[].invest.name` | String | 是 | 投资方投资集团内企业名称 |  |
| `data.items[].sp_id` | String | 是 | 投资方id |  |
| `data.items[].total_amount` | Number | 是 | 总投资金额 |  |
| `data.items[].name` | String | 是 | 投资方名称 |  |
| `data.items[].type` | String | 是 | 投资方类型 |  |
| `data.partner_number` | Number | 是 | 投资方总数 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 61.45 集团图谱

- Hub：`POST /api/v1/data/enterprise/61.45/query`；上游方法 GET（可选 GET/POST）；可调用
- 说明：根据企业名称、统一社会信用代码、注册号获取企业所属集团图谱信息，包括集团内成员名称、集团内类型等。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果， 如果没有匹配记录则返回为空。具体字段 含义见下表 |  |
| `data.eid` | String | 是 | 企业eid |  |
| `data.group_eid` | String | 是 | 集团eid |  |
| `data.group_name` | String | 是 | 集团名称 |  |
| `data.name` | String | 是 | 主企业名称 |  |
| `data.group_number` | String | 是 | 集团成员数 |  |
| `data.nodes` | Array | 是 | 节点数据 |  |
| `data.nodes[].eid` | String | 是 | eid |  |
| `data.nodes[].name` | String | 是 | 名称 |  |
| `data.nodes[].type` | String | 是 | 类型 |  |
| `data.statistics` | String | 是 | 数据详情 |  |
| `data.statistics.eid` | String | 是 | 集团实控人eid |  |
| `data.statistics.name` | String | 是 | 集团实控人名称 |  |
| `data.statistics.type` | String | 是 | 集团实控人类型 |  |
| `data.statistics.percent` | String | 是 | 比例 |  |
| `data.statistics.level` | String | 是 | 类型（0表示实控人信息，非0表示集团内企业信息） |  |
| `data.statistics.relation` | String | 是 | 集团内类型（1：主体；2：核心成员；3：其他成员；9：分支机构） |  |
| `data.statistics.children` | String | 是 | 节点 |  |
| `data.statistics.children.eid` | String | 是 | 企业eid |  |
| `data.statistics.children.name` | String | 是 | 企业名称 |  |
| `data.statistics.children.type` | String | 是 | 企业类型 |  |
| `data.statistics.children.percent` | String | 是 | 比例 |  |
| `data.statistics.children.level` | String | 是 | 类型（0表示实控人信息，非0表示集团内企业信息） |  |
| `data.statistics.children.relation` | String | 是 | 集团内类型（1：主体；2：核心成员；3：其他成员；9：分支机构） |  |
| `data.statistics.children.children` | String | 是 | 节点（如果多级节点，如存在分支机构等，将循环children内的字段） |  |

## 证券信息


### 43.3 股票信息

- Hub：`POST /api/v1/data/enterprise/43.3/query`；上游方法 GET；可调用
- 说明：企业股票信息，包括股票简称、股票代码、交易市场、上市状态等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.list` | Array | 是 | 返回企业股票列表 |  |
| `data.list[].securitycode` | String | 是 | 股票代码 |  |
| `data.list[].e_name` | String | 是 | 企业名称 |  |
| `data.list[].securitysname` | String | 是 | 股票简称 |  |
| `data.list[].trademarket` | String | 是 | 交易市场，包括：上交所主板 上交所科创板 上交所风险警示板 北京证券交易所 新三板 深交所主板 深交所创业板 深交所风险警示板 纽约证券交易所 纽约证券交易所高增长板市场 美国BATS全球市场 美国CBOE全球市场 美国场外柜台交易系统 美国纳斯达克市场 美国证券交易所 老三板 香港交易所主板 香港交易所创业板 |  |
| `data.list[].liststate` | String | 是 | 上市状态（0正常上市1暂停上市2终止上市3恢复上市9未上市10资产重组弃用） |  |
| `data.list[].listdate` | String | 是 | 上市日期 |  |
| `data.list[].eid` | String | 是 | 企业id |  |
| `data.total` | Number | 是 | 返回企业股票总数 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 68.1 上市公司概况

- Hub：`POST /api/v1/data/enterprise/68.1/query`；上游方法 GET；可调用
- 说明：上市企业概况信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.bsecretary` | String | 是 | 董事会秘书 |  |
| `data.trademarket` | String | 是 | 交易市场,枚举值：北京证券交易所、上交所主板、上交所科创板、上交所风险警示板、老三板、新三板、深交所主板、深交所风险警示板、深交所创业板 |  |
| `data.legrepresent` | String | 是 | 法定代表人 |  |
| `data.compprofile` | String | 是 | 公司简介 |  |
| `data.companyname` | String | 是 | 机构全称 |  |
| `data.legaladvisor` | String | 是 | 律师事务所 |  |
| `data.gmanager` | String | 是 | 总经理 |  |
| `data.secpresent` | String | 是 | 证券事务代表 |  |
| `data.compfax` | String | 是 | 公司传真 |  |
| `data.officepostcode` | String | 是 | 办公地址邮政编码 |  |
| `data.compemail` | String | 是 | 公司电子邮箱 |  |
| `data.compweb` | String | 是 | 公司网址 | 🔗 |
| `data.managernum` | String | 是 | 管理人 |  |
| `data.officeaddress` | String | 是 | 办公地址 |  |
| `data.namechange` | Array | 是 | 名称变更信息列表 |  |
| `data.namechange[].changeb` | String | 是 | 名称变更 |  |
| `data.namechange[].changedate` | String | 是 | 名称变更日期 |  |
| `data.chairman` | String | 是 | 董事长 |  |
| `data.accountingfirm` | String | 是 | 会计事务所 |  |
| `data.senname` | String | 是 | 英文简称 |  |
| `data.securitytype` | String | 是 | 证券类型，A股、B股、三板股。 |  |
| `data.accountingfirmeid` | String | 是 | 会计事务所id |  |
| `data.eid` | String | 是 | 企业id |  |
| `data.companysname` | String | 是 | 机构简称 |  |
| `data.fenname` | String | 是 | 英文全称 |  |
| `data.compphone` | String | 是 | 公司电话 |  |
| `data.employmun` | String | 是 | 职工人数 |  |
| `data.legaladvisoreid` | String | 是 | 律师事务所id |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 68.2 股东人数

- Hub：`POST /api/v1/data/enterprise/68.2/query`；上游方法 GET；可调用
- 说明：上市企业股东人数信息，包括前十大股东（流通股东）持股合计，股东总户数、人均已流通股、及变化等信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 股东信息列表 |  |
| `data.items[].totsharehdratio` | String | 是 | 前十大股东持股合计 |  |
| `data.items[].totcirholdratio` | String | 是 | 前十大流通股东持股合计 |  |
| `data.items[].totalsh` | String | 是 | 股东总户数 |  |
| `data.items[].avgurshareradio` | String | 是 | 人均已流通股较上期变化 |  |
| `data.items[].totalshchangeradio` | String | 是 | 股东户数较上期变化 |  |
| `data.items[].enddate` | String | 是 | 截止日期 |  |
| `data.items[].avgurshare` | String | 是 | 人均已流通股 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 68.3 十大股东

- Hub：`POST /api/v1/data/enterprise/68.3/query`；上游方法 GET；可调用
- 说明：上市企业十大股东信息，包括前十大股东股东名称、股份类型，及持股比例、本期变动比例等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |
| `date` | String | 是 | 发布日期，YYY-XX-MM |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.date` | string | 是 | 发布日期 |  |
| `data.items` | Array | 是 | 十大股东信息列表 |  |
| `data.items[].sharehdname` | String | 是 | 股东名称 |  |
| `data.items[].sharehdnum` | String | 是 | 持股数 |  |
| `data.items[].changeamountratio` | String | 是 | 本期变动比例 |  |
| `data.items[].changeamount` | String | 是 | 本期变动股数 |  |
| `data.items[].sharetype` | String | 是 | 股份类型 |  |
| `data.items[].sharehdcode` | String | 是 | 股东代码eid |  |
| `data.items[].sharehdtypecode` | String | 是 | 股东类型code |  |
| `data.items[].sharehdtype` | String | 是 | 股东类型 |  |
| `data.items[].sharehdratio` | String | 是 | 持股比例 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 68.4 十大流通股东

- Hub：`POST /api/v1/data/enterprise/68.4/query`；上游方法 GET；可调用
- 说明：上市企业十大流通股东信息，包括前十大流通股东股东名称、股份类型，及持股比例、本期变动比例等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |
| `date` | String | 是 | 发布日期，每个季度最后一天，格式： YYYY-MM-DD |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 十大流动股东信息列表 |  |
| `data.items[].sharestype` | String | 是 | 股份类型 |  |
| `data.items[].sharehdnum` | String | 是 | 持股数 |  |
| `data.items[].changeamountratio` | String | 是 | 本期变动比例 |  |
| `data.items[].listsharratio` | String | 是 | 占已上市流通股比例 |  |
| `data.items[].changeamount` | String | 是 | 本期变动股数 |  |
| `data.items[].sharehdtypecode` | String | 是 | 股东类型code |  |
| `data.items[].sharehdcode` | String | 是 | 股东代码eid |  |
| `data.items[].sharehdratio` | String | 是 | 持股比例 |  |
| `data.items[].sharehdtype` | String | 是 | 股东类型 |  |
| `data.items[].reportdate` | String | 是 | 报告日期 |  |
| `data.items[].sharehdname` | String | 是 | 股东名称 |  |
| `data.items[].ifpledge` | String | 是 | 是否抵押 |  |
| `data.items[].eid` | String | 是 | 企业eid |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 68.5 上市公司高管

- Hub：`POST /api/v1/data/enterprise/68.5/query`；上游方法 GET；可调用
- 说明：上市企业高管信息，包括姓名、出生日期、性别、薪资、简历等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | A股高管信息列表 |  |
| `data.items[].gspaysh` | String | 是 | 税后薪资 |  |
| `data.items[].personname` | String | 是 | 姓名 |  |
| `data.items[].anualwage` | String | 是 | 税前薪资 |  |
| `data.items[].post` | String | 是 | 职位 |  |
| `data.items[].startdate` | String | 是 | 任职日期 |  |
| `data.items[].resume` | String | 是 | 简历 |  |
| `data.items[].birthdate` | String | 是 | 出生日期 |  |
| `data.items[].highestdegree` | String | 是 | 最高学历 |  |
| `data.items[].sex` | String | 是 | 性别 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 68.6 股本结构

- Hub：`POST /api/v1/data/enterprise/68.6/query`；上游方法 GET；可调用
- 说明：上市企业股本结构信息，总股本，已流通股份、已流通股份占比等其他相关信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.bshare` | String | 是 | 已上市流通B股(万股) |  |
| `data.ashare_percent` | String | 是 | 已上市流通A股占比 |  |
| `data.rshare_percent` | String | 是 | 流通受限股份占比 |  |
| `data.hshare` | String | 是 | 已上市流通H股(万股) |  |
| `data.totalshare` | String | 是 | 总股本(万股) |  |
| `data.ncshare_percent` | String | 是 | 未流通股份占比 |  |
| `data.ltgfhj_percent` | String | 是 | 流通股份合计占比 |  |
| `data.ncshare` | String | 是 | 未流通股份(万股) |  |
| `data.totalshare_percent` | String | 是 | 总股本占比 |  |
| `data.bshare_percent` | String | 是 | 已上市流通B股占比 |  |
| `data.othercirculatedshare` | String | 是 | 其它已流通股份(万股) |  |
| `data.urshare_percent` | String | 是 | 已流通股份占比 |  |
| `data.urshare` | String | 是 | 已流通股份(万股) |  |
| `data.hshare_percent` | String | 是 | 已上市流通H股占比 |  |
| `data.rshare` | String | 是 | 流通受限股份(万股) |  |
| `data.othercirculatedshare_percent` | String | 是 | 其它已流通股份占比 |  |
| `data.ltgfhj` | String | 是 | 流通股份合计(万股) |  |
| `data.ashare` | String | 是 | 已上市流通A股(万股) |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 68.7 股本变动

- Hub：`POST /api/v1/data/enterprise/68.7/query`；上游方法 GET；可调用
- 说明：上市企业股本变动信息，包括股本变动原因及限售持股等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名 |
| `skip` | Number | 否 | 分页参数，单页20条 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 十大股东持股信息列表 |  |
| `data.items[].dnpsharer` | String | 是 | 限售境内自然人持股（万股） |  |
| `data.items[].bshare` | String | 是 | 已上市流通B股（万股） |  |
| `data.items[].statesharer` | String | 是 | 限售国家持股（万股） |  |
| `data.items[].statelpsharer` | String | 是 | 限售国家法人持股（万股） |  |
| `data.items[].urshare` | String | 是 | 已流通股份（万股） |  |
| `data.items[].changedate` | String | 是 | 变动日期 |  |
| `data.items[].noticedate` | String | 是 | 公告日期 |  |
| `data.items[].ashare` | String | 是 | 已上市流通A股（万股） |  |
| `data.items[].otherdsharer` | String | 是 | 限售其他内资持股（万股） |  |
| `data.items[].foreignlpsharer` | String | 是 | 限售境外法人持股（万股） |  |
| `data.items[].ncshare` | String | 是 | 未流通股份（万股） |  |
| `data.items[].foreigncapitalsharer` | String | 是 | 限售外资持股（万股） |  |
| `data.items[].othercirculatedshare` | String | 是 | 其他已流通股份（万股） |  |
| `data.items[].changereason` | String | 是 | 股本变动原因 |  |
| `data.items[].dnotstatelpsharer` | String | 是 | 限售境内非国有法人持股（万股） |  |
| `data.items[].rshare` | String | 是 | 流通受限股份（万股） |  |
| `data.items[].totalshare` | String | 是 | 总股本（万股） |  |
| `data.items[].hshare` | String | 是 | 已上市流通H股（万股） |  |
| `data.items[].foreignnpsharer` | String | 是 | 限售境外法人持股（万股） |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 68.8 十大股东持股变动

- Hub：`POST /api/v1/data/enterprise/68.8/query`；上游方法 GET；可调用
- 说明：上市企业十大股东持股变动信息，包括股东持股变动比例、变动股数及持股数等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 十大股东持股信息列表 |  |
| `data.items[].sharehdname` | String | 是 | 股东名称 |  |
| `data.items[].ori_sharehdnum` | String | 是 | 持股数（数据） |  |
| `data.items[].sharehdnum` | String | 是 | 持股数 |  |
| `data.items[].id` | String | 是 | 变动id |  |
| `data.items[].enddate` | String | 是 | 变动日期 |  |
| `data.items[].sharehdtypecode` | String | 是 | 股东类型code |  |
| `data.items[].ori_changeamount` | String | 是 | 本期变动股数（数据） |  |
| `data.items[].changeamount` | String | 是 | 本期变动股数 |  |
| `data.items[].sharetype` | String | 是 | 股份类型 |  |
| `data.items[].sharehdcode` | String | 是 | 股东eid |  |
| `data.items[].sharehdratio` | String | 是 | 持股比例 |  |
| `data.items[].sharehdtype` | String | 是 | 股东类型 |  |
| `data.items[].changeamountratio` | String | 是 | 本期变动比例 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 68.9 上市公司公告

- Hub：`POST /api/v1/data/enterprise/68.9/query`；上游方法 GET；可调用
- 说明：上市企业上市公告信息，包括上市企业定期报告、财务报告、融资公告、信息变更等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | A股上市公告信息列表 |  |
| `data.items[].id` | String | 是 | id |  |
| `data.items[].sourceurlcc` | String | 是 | 公告链接 | 🔗 |
| `data.items[].noticetitle` | String | 是 | 公告标题 |  |
| `data.items[].infocode` | String | 是 | 资讯编码 |  |
| `data.items[].columnname` | String | 是 | 栏目名称 |  |
| `data.items[].noticedate` | String | 是 | 公告日期 |  |
| `data.items[].columnqxbcode` | String | 是 | 栏目编码 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 68.10 上市公司员工构成

- Hub：`POST /api/v1/data/enterprise/68.10/query`；上游方法 GET；可调用
- 说明：上市企业员工构成信息，包括职工总数、各岗位人员、不同学历人员等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 企业员工信息列表 |  |
| `data.items[].enddate` | String | 是 | 日期 |  |
| `data.items[].id` | String | 是 | 编码id |  |
| `data.items[].salesman` | String | 是 | 销售人员 |  |
| `data.items[].tssnum` | String | 是 | 中专及以下人数 |  |
| `data.items[].otherpersons` | String | 是 | 其它人员 |  |
| `data.items[].cfssme` | String | 是 | 财务人员 |  |
| `data.items[].bachelornum` | String | 是 | 本科人数 |  |
| `data.items[].hndnum` | String | 是 | 大专人数 |  |
| `data.items[].masternum` | String | 是 | 研究生人数 |  |
| `data.items[].technicist` | String | 是 | 技术人员 |  |
| `data.items[].retiredpersons` | String | 是 | 退休人员 |  |
| `data.items[].adstaff` | String | 是 | 行政管理人员 |  |
| `data.items[].workforce` | String | 是 | 职工总数 |  |
| `data.items[].abovedrnum` | String | 是 | 博士以上人数 |  |
| `data.items[].prostaff` | String | 是 | 生产人员 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 68.11 对外担保

- Hub：`POST /api/v1/data/enterprise/68.11/query`；上游方法 GET；可调用
- 说明：上市企业对外担保信息，包括担保方、被担保方基本信息、双方与披露方的关系，担保交易事件说明等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 企业员工信息列表 |  |
| `data.items[].guarstartdate` | String | 是 | 担保起始日期 |  |
| `data.items[].securityname` | String | 是 | 信息披露方_名称 |  |
| `data.items[].eid` | String | 是 | 信息披露方eid |  |
| `data.items[].buarrelation` | String | 是 | 被担保方_与披露方关系 |  |
| `data.items[].guareid` | String | 是 | 担保方eid |  |
| `data.items[].id` | String | 是 | id |  |
| `data.items[].guarjine` | String | 是 | 担保金额 |  |
| `data.items[].reportdate` | String | 是 | 报告期 |  |
| `data.items[].tradedate` | String | 是 | 交易日期 |  |
| `data.items[].noticedate` | String | 是 | 公告日期 |  |
| `data.items[].isrltrade` | String | 是 | 是否关联交易，0 否 ，1 是 |  |
| `data.items[].guarenddate` | String | 是 | 担保终止日期 |  |
| `data.items[].guarrelation` | String | 是 | 担保方_与披露方关系 |  |
| `data.items[].reporttype` | String | 是 | 报告期类别：1年报；2中报；3一季度报告；4三季度报告；5临时公告; 6申报稿; 7说明书; 8意向书; 9公告书 |  |
| `data.items[].buareid` | String | 是 | 被担保方eid |  |
| `data.items[].guarmethod` | String | 是 | 担保方式 |  |
| `data.items[].isperform` | String | 是 | 是否履行完毕；0 否 ，1 是 |  |
| `data.items[].warcontent` | String | 是 | 担保事件说明 |  |
| `data.items[].guardealine` | String | 是 | 担保期限(年) |  |
| `data.items[].currency` | String | 是 | 币种 |  |
| `data.items[].guarcomname` | String | 是 | 担保方_公司名称 |  |
| `data.items[].buarcomname` | String | 是 | 被担保方_公司名称 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 68.12 违规处理

- Hub：`POST /api/v1/data/enterprise/68.12/query`；上游方法 GET；可调用
- 说明：上市企业违规处理信息，包括处分对象、违规行为、处罚金额、处分类型等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 违规处理信息列表 |  |
| `data.items[].punishstep` | String | 是 | 处分措施 |  |
| `data.items[].id` | String | 是 | id |  |
| `data.items[].punishtype` | String | 是 | 处分类型 |  |
| `data.items[].punishobjecteid` | String | 是 | 处罚对象eid |  |
| `data.items[].goolaction` | String | 是 | 违规行为 |  |
| `data.items[].handleperson` | String | 是 | 处理人 |  |
| `data.items[].punishjine` | String | 是 | 处罚金额(万元) |  |
| `data.items[].punishobject` | String | 是 | 处罚对象 |  |
| `data.items[].gooltype` | String | 是 | 违规类型 |  |
| `data.items[].noticedate` | String | 是 | 公告日期 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 68.13 分红情况

- Hub：`POST /api/v1/data/enterprise/68.13/query`；上游方法 GET；可调用
- 说明：上市企业分红情况信息，包括股权实施方案简述、现金红利发放日、分配进度等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 分红信息列表 |  |
| `data.items[].exdividenddate` | String | 是 | 除权除息日 |  |
| `data.items[].assignprogress` | String | 是 | 分配进度 |  |
| `data.items[].divipaydate` | String | 是 | 现金红利发放日 |  |
| `data.items[].assigndscrpt` | String | 是 | 实施方案简述 |  |
| `data.items[].noticedate` | String | 是 | 公告日期 |  |
| `data.items[].rightregdate` | String | 是 | 股权登记日 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 68.14 增发情况

- Hub：`POST /api/v1/data/enterprise/68.14/query`；上游方法 GET；可调用
- 说明：上市企业增发情况信息，包括增发价格、上市日，以及募集资金金额和净额等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 增发信息列表 |  |
| `data.items[].sumfina` | String | 是 | 募集资金总额 |  |
| `data.items[].zjdzr` | String | 是 | 资金到账日 |  |
| `data.items[].issuemethoddscrpt` | String | 是 | 发行方式说明 |  |
| `data.items[].netsumfina` | String | 是 | 募集资金净额 |  |
| `data.items[].gqdjr` | String | 是 | 股权登记日 |  |
| `data.items[].zfssr` | String | 是 | 增发上市日 |  |
| `data.items[].shareissued` | String | 是 | 发行数量 |  |
| `data.items[].noticedate` | String | 是 | 增发公告日期 |  |
| `data.items[].issueprice` | String | 是 | 增发价格 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 68.15 配股情况

- Hub：`POST /api/v1/data/enterprise/68.15/query`；上游方法 GET；可调用
- 说明：上市企业配股情况信息，包括配股价格、上市日，以及募集资金金额和净额等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 配股信息列表 |  |
| `data.items[].sumfina` | String | 是 | 募集资金总额 |  |
| `data.items[].shareissued` | String | 是 | 实际配股数量 |  |
| `data.items[].netsumfina` | String | 是 | 募集资金净额 |  |
| `data.items[].pgssr` | String | 是 | 配股上市日 |  |
| `data.items[].gqdjr` | String | 是 | 股权登记日 |  |
| `data.items[].cqjzr` | String | 是 | 除权基准日 |  |
| `data.items[].placeratio` | String | 是 | 配售比例(10：X) |  |
| `data.items[].noticedate` | String | 是 | 配股公告日期 |  |
| `data.items[].issueprice` | String | 是 | 配股价格 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 68.17 财务主要指标

- Hub：`POST /api/v1/data/enterprise/68.17/query`；上游方法 GET；可调用
- 说明：上市企业财务主要指标信息，包括成长能力指标、每股指标、盈利能力指标、财务风险指标和运营能力指标信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前10条，取11到20条的数据，skip=10，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 财务指标信息列表 |  |
| `data.items[].cwfxzb` | Object | 是 | 财务风险指标 |  |
| `data.items[].cwfxzb.ld` | String | 是 | 流动比率 |  |
| `data.items[].cwfxzb.sd` | String | 是 | 速动比率 |  |
| `data.items[].cwfxzb.ldchj` | Number | 是 | 流动负债/负债合计 |  |
| `data.items[].cwfxzb.zcfzl` | Number | 是 | 资产负债率 |  |
| `data.items[].cwfxzb.jyxjecld` | String | 是 | 现金流动负债比率 |  |
| `data.items[].mgzb` | Object | 是 | 每股指标 |  |
| `data.items[].mgzb.ebit` | String | 是 | EBIT(正推法) |  |
| `data.items[].mgzb.yhlxbs` | String | 是 | 利息保障倍数 |  |
| `data.items[].mgzb.epsjb` | String | 是 | 每股收益 EPS(基本) |  |
| `data.items[].mgzb.epskcjb` | String | 是 | 扣非每股收益 EPS |  |
| `data.items[].mgzb.mgwfplr` | String | 是 | 每股未分配利润 |  |
| `data.items[].mgzb.epsxs` | String | 是 | 每股收益 EPS(稀释) |  |
| `data.items[].mgzb.mgzbgj` | String | 是 | 每股资本公积 |  |
| `data.items[].mgzb.mgjyxjje` | String | 是 | 每股经营现金流 |  |
| `data.items[].mgzb.bps` | String | 是 | 每股净资产 BPS |  |
| `data.items[].ylzlzb` | Object | 是 | 盈利质量指标 |  |
| `data.items[].ylzlzb.jcsxjecys` | Number | 是 | 经营现金流/营业收入 |  |
| `data.items[].ylzlzb.xtlxjcys` | String | 是 | 销售现金流/营业收入 |  |
| `data.items[].ylzlzb.avglrzz` | Number | 是 | 三年利润平均增长率，年报会返回值number，季报和半年报会返回null |  |
| `data.items[].ylzlzb.avgzbzz` | Number | 是 | 三年资本平均增长率，年报会返回值，季报和半年报会返回null |  |
| `data.items[].reportdate` | String | 是 | 上报日期 |  |
| `data.items[].yynlzb` | Object | 是 | 运营能力指标 |  |
| `data.items[].yynlzb.toazzl` | Number | 是 | 总资产周转率（次） |  |
| `data.items[].yynlzb.yszkzzts` | String | 是 | 应收账款周转天数（天） |  |
| `data.items[].yynlzb.chzzl` | String | 是 | 存货周转率（次） |  |
| `data.items[].yynlzb.yszkzzl` | String | 是 | 应收账款周转率(次) |  |
| `data.items[].yynlzb.ldzczzl` | String | 是 | 流动资产周转率(次) |  |
| `data.items[].yynlzb.gdzczzl` | String | 是 | 固定资产周转率(次) |  |
| `data.items[].cznlzb` | Object | 是 | 成长能力指标 |  |
| `data.items[].cznlzb.tystz` | Number | 是 | 营业总收入同比增长(%) |  |
| `data.items[].cznlzb.mlr` | String | 是 | 毛利润(元) |  |
| `data.items[].cznlzb.sjlktz` | Number | 是 | 扣非净利润同比增长(%) |  |
| `data.items[].cznlzb.kcfjcxsyjlr` | String | 是 | 扣非净利润(元) |  |
| `data.items[].cznlzb.sjltz` | Number | 是 | 归属净利润同比增长(%) |  |
| `data.items[].cznlzb.jlrtbzcl` | Number | 是 | 净利润增长率(%) |  |
| `data.items[].cznlzb.tsatz` | Number | 是 | 总资产增长率(%) |  |
| `data.items[].cznlzb.yltz` | Number | 是 | 营业利润增长率(%) |  |
| `data.items[].cznlzb.nsatz` | Number | 是 | 净资产增长率(%) |  |
| `data.items[].cznlzb.yffy` | Number | 是 | 研发费用 |  |
| `data.items[].cznlzb.jlrczsr` | Number | 是 | 营业净利率 |  |
| `data.items[].format_reportdate` | String | 是 | 格式化上报日期 |  |
| `data.items[].ylnlzb` | Object | 是 | 盈利能力指标 |  |
| `data.items[].ylnlzb.zzcjll` | Number | 是 | 总资产净利率 |  |
| `data.items[].ylnlzb.roetb` | Number | 是 | 净资产收益率 ROE(摊薄) |  |
| `data.items[].ylnlzb.roejq` | Number | 是 | 净资产收益率 ROE(加权) |  |
| `data.items[].ylnlzb.xsmll` | String | 是 | 销售毛利率 |  |
| `data.items[].ylnlzb.xsjll` | Number | 是 | 销售净利率 |  |
| `data.items[].ylnlzb.yltz` | Number | 是 | 营业利润率(%) |  |
| `data.items[].ylnlzb.jlrtbzcl` | Number | 是 | 净利润率(%) |  |
| `data.items[].ylnlzb.roa` | String | 是 | 总资产报酬率(%) |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 68.20 现金流量表

- Hub：`POST /api/v1/data/enterprise/68.20/query`；上游方法 GET；可调用
- 说明：上市企业现金流量表信息，包括经营活动现金流出、筹资活动产生的现金流入和投资活动现金流入等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前10条，取11到20条的数据，skip=10，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.fntype` | String | 是 | 类型127000000606280264：银行 127000000606280720：保险 127000000606281107：证券 127000000606281483：通用 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].format_reportdate` | String | 是 | 格式化上报日期 |  |
| `data.items[].fntype` | String | 是 | 127000000606281483 |  |
| `data.items[].reportdate` | String | 是 | 上报日期。fntype=127000000606281483 |  |
| `data.items[].jyhdxjlc` | Object | 是 | 经营活动现金流出 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.operateflowoutother` | String | 是 | 经营活动现金流出其他项目 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.taxpay` | String | 是 | 支付的各项税费 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.employeepay` | String | 是 | 支付给职工以及为职工支付的现金 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.nidepositincbankfi` | String | 是 | 存放中央银行和同业款项净增加额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.intandcommpay` | String | 是 | 支付利息、手续费及佣金的现金 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.divipay` | String | 是 | 支付保单红利的现金 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.operateflowoutbalance` | String | 是 | 经营活动现金流出平衡项目 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.sumoperateflowout` | String | 是 | 经营活动现金流出小计 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.indemnitypay` | String | 是 | 支付原保险合同赔付款项的现金 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.otheroperatepay` | String | 是 | 支付其他与经营活动有关的现金 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.niloanadvances` | String | 是 | 客户贷款及垫款净增加额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.buygoodsservicepay` | String | 是 | 购买商品、接受劳务支付的现金 |  |
| `data.items[].czhdxjlr` | Object | 是 | 筹资活动现金流入 |  |
| `data.items[].czhdxjlr.czhdxjlr.invflowbalance` | String | 是 | 投资活动产生的现金流量净额平衡项目 |  |
| `data.items[].czhdxjlr.czhdxjlr.issuebondrec` | String | 是 | 发行债券收到的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.finaflowinother` | String | 是 | 筹资活动现金流入其他项目 |  |
| `data.items[].czhdxjlr.czhdxjlr.subsidiaryaccept` | String | 是 | 子公司吸收少数股东投资收到的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.loanrec` | String | 是 | 取得借款收到的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.finaflowinbalance` | String | 是 | 筹资活动现金流入平衡项目 |  |
| `data.items[].czhdxjlr.czhdxjlr.sumfinaflowin` | String | 是 | 筹资活动现金流入小计 |  |
| `data.items[].czhdxjlr.czhdxjlr.otherfinarec` | String | 是 | 收到其他与筹资活动有关的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.acceptinvrec` | String | 是 | 吸收投资收到的现金 |  |
| `data.items[].jyhdcsdxjllje` | Object | 是 | 经营活动产生的现金流量净额 |  |
| `data.items[].jyhdcsdxjllje.jyhdcsdxjllje.operateflowbalance` | String | 是 | 经营活动产生的现金流量净额平衡项目 |  |
| `data.items[].jyhdcsdxjllje.jyhdcsdxjllje.operateflowother` | String | 是 | 经营活动产生的现金流量净额其他项目 |  |
| `data.items[].jyhdcsdxjllje.jyhdcsdxjllje.netoperatecashflow` | String | 是 | 经营活动产生的现金流量净额 |  |
| `data.items[].tzhdxjlr` | Object | 是 | 投资活动现金流入 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.invincomerec` | String | 是 | 取得投资收益收到的现金 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.dispfilassetrec` | String | 是 | 处置固定资产、无形资产和其他长期资产收回的现金净额 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.otherinvrec` | String | 是 | 收到其他与投资活动有关的现金 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.invflowinbalance` | String | 是 | 投资活动现金流入平衡项目 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.invflowinother` | String | 是 | 投资活动现金流入其他项目 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.suminvflowin` | String | 是 | 投资活动现金流入小计 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.disposalinvrec` | String | 是 | 收回投资收到的现金 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.reducepledgetdeposit` | String | 是 | 减少质押和定期存款所收到的现金 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.dispsubsidiaryrec` | String | 是 | 处置子公司及其他营业单位收到的现金净额 |  |
| `data.items[].czhdcsdxjllje` | Object | 是 | 筹资活动产生的现金流量净额 |  |
| `data.items[].czhdcsdxjllje.czhdcsdxjllje.finaflowbalance` | String | 是 | 筹资活动产生的现金流量净额平衡项目 |  |
| `data.items[].czhdcsdxjllje.czhdcsdxjllje.finaflowother` | String | 是 | 筹资活动产生的现金流量净额其他项目 |  |
| `data.items[].czhdcsdxjllje.czhdcsdxjllje.netfinacashflow` | String | 是 | 筹资活动产生的现金流量净额 |  |
| `data.items[].qmxjjxjdjwye` | Object | 是 | 期初现金及现金等价物余额 |  |
| `data.items[].qmxjjxjdjwye.qmxjjxjdjwye.cashequibeginning` | String | 是 | 期初现金及现金等价物余额 |  |
| `data.items[].qmxjjxjdjwye.qmxjjxjdjwye.cashequiendingother` | String | 是 | 期末现金及现金等价物余额其他项目 |  |
| `data.items[].qmxjjxjdjwye.qmxjjxjdjwye.cashequiending` | String | 是 | 期末现金及现金等价物余额 |  |
| `data.items[].qmxjjxjdjwye.qmxjjxjdjwye.cashequiendingbalan` | String | 是 | 期末现金及现金等价物余额平衡项目 |  |
| `data.items[].xjjxjdjwjzje` | Object | 是 | 现金及现金等价物净增加额 |  |
| `data.items[].xjjxjdjwjzje.xjjxjdjwjzje.nicashequi` | String | 是 | 现金及现金等价物净增加额 |  |
| `data.items[].xjjxjdjwjzje.xjjxjdjwjzje.nicashequibalance` | String | 是 | 现金及现金等价物净增加额平衡项目 |  |
| `data.items[].xjjxjdjwjzje.xjjxjdjwjzje.nicashequiother` | String | 是 | 现金及现金等价物净增加额其他项目 |  |
| `data.items[].hlbddxjjxjdjwdyx` | Object | 是 | 汇率变动对现金及现金等价物的影响 |  |
| `data.items[].hlbddxjjxjdjwdyx.effectexchangerate` | String | 是 | 汇率变动对现金及现金等价物的影响 |  |
| `data.items[].jyhdxjlr` | Object | 是 | 经营活动现金流入 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.operateflowinother` | String | 是 | 经营活动现金流入其他项目 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.nideposit` | String | 是 | 客户存款和同业存放款项净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.otheroperaterec` | String | 是 | 收到其他与经营活动有关的现金 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.operateflowinbalance` | String | 是 | 经营活动现金流入平衡项目 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.niborrowfund` | String | 是 | 拆入资金净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.premiumrec` | String | 是 | 收到原保险合同保费取得的现金 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.niborrowfromcbank` | String | 是 | 向中央银行借款净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.ndloanadvances` | String | 是 | 发放贷款及垫款的净减少额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.niborrowfromfi` | String | 是 | 向其他金融机构拆入资金净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.taxreturnrec` | String | 是 | 收到的税费返还 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.intandcommrec` | String | 是 | 收取利息、手续费及佣金的现金 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.salegoodsservicerec` | String | 是 | 销售商品、提供劳务收到的现金 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.netrirec` | String | 是 | 收到再保险业务现金净额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.nibuybackfund` | String | 是 | 回购业务资金净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.sumoperateflowin` | String | 是 | 经营活动现金流入小计 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.niinsureddepositinv` | String | 是 | 保户储金及投资款净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.nidisptradefasset` | String | 是 | 处置交易性金融资产净增加额 |  |
| `data.items[].czhdxjlc` | Object | 是 | 筹资活动现金流出 |  |
| `data.items[].czhdxjlc.czhdxjlc.finaflowoutbalance` | String | 是 | 筹资活动现金流出平衡项目 |  |
| `data.items[].czhdxjlc.czhdxjlc.finaflowoutother` | String | 是 | 筹资活动现金流出其他项目 |  |
| `data.items[].czhdxjlc.czhdxjlc.buysubsidiarypay` | String | 是 | 购买子公司少数股权而支付的现金 |  |
| `data.items[].czhdxjlc.czhdxjlc.otherfinapay` | String | 是 | 支付其他与筹资活动有关的现金 |  |
| `data.items[].czhdxjlc.czhdxjlc.diviprofitorintpay` | String | 是 | 分配股利、利润或偿付利息支付的现金 |  |
| `data.items[].czhdxjlc.czhdxjlc.sumfinaflowout` | String | 是 | 筹资活动现金流出小计 |  |
| `data.items[].czhdxjlc.czhdxjlc.repaydebtpay` | String | 是 | 偿还债务支付的现金 |  |
| `data.items[].czhdxjlc.czhdxjlc.subsidiaryreductcapital` | String | 是 | 子公司减资支付给少数股东的现金 |  |
| `data.items[].czhdxjlc.czhdxjlc.subsidiarypay` | String | 是 | 子公司支付给少数股东的股利、利润 |  |
| `data.items[].tzhdcsdxjllje` | Object | 是 | 投资活动产生的现金流量净额 |  |
| `data.items[].tzhdcsdxjllje.tzhdcsdxjllje.netinvcashflow` | String | 是 | 投资活动产生的现金流量净额 |  |
| `data.items[].tzhdcsdxjllje.tzhdcsdxjllje.invflowother` | String | 是 | 投资活动产生的现金流量净额其他项目 |  |
| `data.items[].tzhdcsdxjllje.tzhdcsdxjllje.invflowoutbalance` | String | 是 | 投资活动现金流出平衡项目 |  |
| `data.items[].tzhdxjlc` | Object | 是 | 投资活动现金流出 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.suminvflowout` | String | 是 | 投资活动现金流出小计 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.nipledgeloan` | String | 是 | 质押贷款净增加额 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.otherinvpay` | String | 是 | 支付其他与投资活动有关的现金 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.getsubsidiarypay` | String | 是 | 取得子公司及其他营业单位支付的现金净额 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.buyfilassetpay` | String | 是 | 购建固定资产、无形资产和其他长期资产支付的现金 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.invflowoutother` | String | 是 | 投资活动现金流出其他项目 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.invpay` | String | 是 | 投资支付的现金 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.addpledgetdeposit` | String | 是 | 增加质押和定期存款所支付的现金 |  |
| `data.items[].format_reportdate` | String | 是 | 格式化上报日期 |  |
| `data.items[].fntype` | String | 是 | 127000000606281107 |  |
| `data.items[].reportdate` | String | 是 | 上报日期。fntype = 127000000606281107 |  |
| `data.items[].jyhdxjlc` | Object | 是 | 经营活动现金流出 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.operateflowoutother` | String | 是 | 经营活动现金流出的其他项目 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.taxpay` | String | 是 | 支付的各项税费 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.sumoperateflowout` | String | 是 | 经营活动现金流出小计 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.employeepay` | String | 是 | 支付给职工及为职工支付的现金 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.nddirectinv` | String | 是 | 直接投资经营资金减少 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.ndtradesettlement` | String | 是 | 客户交易结算资金减少 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.intandcommpay` | String | 是 | 支付利息、手续费及佣金的现金 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.otheroperatepay` | String | 是 | 支付其他与经营活动有关的现金 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.operateflowoutbalance` | String | 是 | 经营活动现金流出的平衡项目 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.nilendfund` | String | 是 | 拆出资金净增加额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.ndbuybackfund` | String | 是 | 回购业务资金净减少额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.ndotherfinainstr` | String | 是 | 购买、处置或发行其他金融工具净减少额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.agenttradesecuritypay` | String | 是 | 代理买卖证券支付的现金净额（净减少额） |  |
| `data.items[].jyhdxjlc.jyhdxjlc.buysellbackfassetpay` | String | 是 | 买入返售金融资产支付的现金净额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.ndborrowfund` | String | 是 | 拆入资金净减少额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.nddisptradefasset` | String | 是 | 处置交易性金融资产的净减少额 |  |
| `data.items[].czhdxjlr` | Object | 是 | 筹资活动现金流入 |  |
| `data.items[].czhdxjlr.czhdxjlr.acceptinvrec` | String | 是 | 吸收投资收到的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.subsidiaryaccept` | String | 是 | 子公司吸收少数股东投资收到的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.loanrec` | String | 是 | 取得借款收到的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.sumfinaflowin` | String | 是 | 筹资活动现金流入小计 |  |
| `data.items[].czhdxjlr.czhdxjlr.finaflowinbalance` | String | 是 | 筹资活动现金流入的平衡项目 |  |
| `data.items[].czhdxjlr.czhdxjlr.otherfinarec` | String | 是 | 收到的其他与筹资活动有关的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.issuebondrec` | String | 是 | 发行债券收到的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.intandcommrec` | String | 是 | 收取利息、手续费及佣金的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.finaflowinother` | String | 是 | 筹资活动现金流入的其他项目 |  |
| `data.items[].jyhdcsdxjllje` | Object | 是 | 经营活动产生的现金流量净额 |  |
| `data.items[].jyhdcsdxjllje.jyhdcsdxjllje.operateflowbalance` | String | 是 | 经营活动产生的现金流量净额平衡项目 |  |
| `data.items[].jyhdcsdxjllje.jyhdcsdxjllje.operateflowother` | String | 是 | 经营活动产生的现金流量净额其他项目 |  |
| `data.items[].jyhdcsdxjllje.jyhdcsdxjllje.netoperatecashflow` | String | 是 | 经营活动产生的现金流量净额 |  |
| `data.items[].tzhdxjlr` | Object | 是 | 投资活动现金流入 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.nidispsaleablefasset` | String | 是 | 处置可供出售金融资产净增加额 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.invincomerec` | String | 是 | 取得投资收益收到的现金 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.dispfilassetrec` | String | 是 | 处置固定资产、无形资产及其他长期资产收回的现金净额 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.otherinvrec` | String | 是 | 收到其他与投资活动有关的现金 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.invflowinbalance` | String | 是 | 投资活动现金流入的平衡项目 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.invflowinother` | String | 是 | 投资活动现金流入的其他项目 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.suminvflowin` | String | 是 | 投资活动现金流入小计 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.disposalinvrec` | String | 是 | 收回投资所收到的现金 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.dispsubsidiaryrec` | String | 是 | 处置子公司及其他营业单位收到的现金 |  |
| `data.items[].czhdcsdxjllje` | Object | 是 | 筹资活动产生的现金流量净额 |  |
| `data.items[].czhdcsdxjllje.czhdcsdxjllje.finaflowbalance` | String | 是 | 筹资活动产生的现金流量净额平衡项目 |  |
| `data.items[].czhdcsdxjllje.czhdcsdxjllje.finaflowother` | String | 是 | 筹资活动产生的现金流量净额其他项目 |  |
| `data.items[].czhdcsdxjllje.czhdcsdxjllje.netfinacashflow` | String | 是 | 筹资活动产生的现金流量净额 |  |
| `data.items[].qmxjjxjdjwye` | Object | 是 | 期末现金及现金等价物余额 |  |
| `data.items[].qmxjjxjdjwye.qmxjjxjdjwye.cashequibeginning` | String | 是 | 期初现金及现金等价物余额 |  |
| `data.items[].qmxjjxjdjwye.qmxjjxjdjwye.cashequiendingother` | String | 是 | 期末现金及现金等价物余额其他项目 |  |
| `data.items[].qmxjjxjdjwye.qmxjjxjdjwye.cashequiending` | String | 是 | 期末现金及现金等价物余额 |  |
| `data.items[].qmxjjxjdjwye.qmxjjxjdjwye.cashequiendingbalan` | String | 是 | 期末现金及现金等价物余额平衡项目 |  |
| `data.items[].xjjxjdjwjzje` | Object | 是 | 现金及现金等价物净增加额 |  |
| `data.items[].xjjxjdjwjzje.xjjxjdjwjzje.nicashequi` | String | 是 | 现金及现金等价物净增加额 |  |
| `data.items[].xjjxjdjwjzje.xjjxjdjwjzje.nicashequibalance` | String | 是 | 现金及现金等价物净增加额平衡项目 |  |
| `data.items[].xjjxjdjwjzje.xjjxjdjwjzje.nicashequiother` | String | 是 | 现金及现金等价物净增加额其他项目 |  |
| `data.items[].hlbddxjjxjdjwdyx` | Object | 是 | 汇率变动对现金及现金等价物的影响 |  |
| `data.items[].hlbddxjjxjdjwdyx.effectexchangerate` | String | 是 | 汇率变动对现金及现金等价物的影响 |  |
| `data.items[].jyhdxjlr` | Object | 是 | 经营活动现金流入 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.agentuwsecurityrec` | String | 是 | 代理承销证券收到的现金净额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.sumoperateflowin` | String | 是 | 经营活动现金流入小计 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.operateflowinbalance` | String | 是 | 经营活动现金流入的平衡项目 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.buysellbackfassetrec` | String | 是 | 买入返售金融资产收到的现金 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.nidirectinv` | String | 是 | 直接投资经营资金增加 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.operateflowinother` | String | 是 | 经营活动现金流入的其他项目 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.otheroperaterec` | String | 是 | 收到其他与经营活动有关的现金 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.niborrowfund` | String | 是 | 拆入资金净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.taxreturnrec` | String | 是 | 收到的税费返还 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.nitradesettlement` | String | 是 | 客户交易结算资金增加 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.nibuybackfund` | String | 是 | 回购业务资金净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.nidisptradefasset` | String | 是 | 处置交易性金融资产净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.uwsecurityrec` | String | 是 | 承销证券收到的现金净额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.agenttradesecurityrec` | String | 是 | 代理买卖证券收到的现金净额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.niotherfinainstru` | String | 是 | 购买、处置或发行其他金融工具净增加额 |  |
| `data.items[].czhdxjlc` | Object | 是 | 筹资活动现金流出 |  |
| `data.items[].czhdxjlc.czhdxjlc.finaflowoutbalance` | String | 是 | 筹资活动现金流出的平衡项目 |  |
| `data.items[].czhdxjlc.czhdxjlc.finaflowoutother` | String | 是 | 筹资活动现金流出的其他项目 |  |
| `data.items[].czhdxjlc.czhdxjlc.sumfinaflowout` | String | 是 | 筹资活动现金流出小计 |  |
| `data.items[].czhdxjlc.czhdxjlc.repaydebtpay` | String | 是 | 偿还债务支付的现金 |  |
| `data.items[].czhdxjlc.czhdxjlc.otherfinapay` | String | 是 | 支付其他与筹资活动有关的现金 |  |
| `data.items[].czhdxjlc.czhdxjlc.subsidiarypay` | String | 是 | 子公司支付给少数股东的股利、利润 |  |
| `data.items[].czhdxjlc.czhdxjlc.diviprofitorintpay` | String | 是 | 分配股利、利润或偿付利息支付的现金 |  |
| `data.items[].tzhdcsdxjllje` | Object | 是 | 投资活动产生的现金流量净额 |  |
| `data.items[].tzhdcsdxjllje.tzhdcsdxjllje.invflowbalance` | String | 是 | 投资活动产生的现金流量净额平衡项目 |  |
| `data.items[].tzhdcsdxjllje.tzhdcsdxjllje.invflowother` | String | 是 | 投资活动产生的现金流量净额其他项目 |  |
| `data.items[].tzhdcsdxjllje.tzhdcsdxjllje.netinvcashflow` | String | 是 | 投资活动产生的现金流量净额 |  |
| `data.items[].tzhdxjlc` | Object | 是 | 投资活动现金流出 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.suminvflowout` | String | 是 | 投资活动现金流出小计 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.otherinvpay` | String | 是 | 支付其他与投资活动有关的现金 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.nddispsaleablefasset` | String | 是 | 处置可供出售金融资产净减少额 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.getsubsidiarypay` | String | 是 | 取得子公司及其他营业单位支付的现金净额 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.buyfilassetpay` | String | 是 | 购建固定资产、无形资产和其他长期资产支付的现金 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.invflowoutother` | String | 是 | 投资活动现金流出的其他项目 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.invpay` | String | 是 | 投资支付的现金 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.invflowoutbalance` | String | 是 | 投资活动现金流出的平衡项目 |  |
| `data.items[].format_reportdate` | String | 是 | 格式化上报日期 |  |
| `data.items[].fntype` | String | 是 | 127000000606280720 |  |
| `data.items[].reportdate` | String | 是 | 上报日期。fntype=127000000606280720 |  |
| `data.items[].czhdxjlr` | Object | 是 | 筹资活动现金流入 |  |
| `data.items[].czhdxjlr.czhdxjlr.acceptinvrec` | String | 是 | 吸收投资收到的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.sumfinaflowin` | String | 是 | 筹资活动现金流入小计 |  |
| `data.items[].czhdxjlr.czhdxjlr.loanrec` | String | 是 | 取得借款收到的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.finaflowinother` | String | 是 | 筹资活动现金流入的其他项目 |  |
| `data.items[].czhdxjlr.czhdxjlr.finaflowinbalance` | String | 是 | 筹资活动现金流入的平衡项目 |  |
| `data.items[].czhdxjlr.czhdxjlr.otherfinarec` | String | 是 | 收到的其他与筹资活动有关的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.issuebondrec` | String | 是 | 发行债券收到的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.netsellbuybackfassetrec` | String | 是 | 收到卖出回购金融资产款现金净额 |  |
| `data.items[].jyhdcsdxjllje` | Object | 是 | 经营活动产生的现金流量净额 |  |
| `data.items[].jyhdcsdxjllje.jyhdcsdxjllje.operateflowbalance` | String | 是 | 经营活动产生的现金流量净额平衡项目 |  |
| `data.items[].jyhdcsdxjllje.jyhdcsdxjllje.operateflowother` | String | 是 | 经营活动产生的现金流量净额其他项目 |  |
| `data.items[].jyhdcsdxjllje.jyhdcsdxjllje.netoperatecashflow` | String | 是 | 经营活动产生的现金流量净额 |  |
| `data.items[].tzhdxjlr` | Object | 是 | 投资活动现金流入 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.invincomerec` | String | 是 | 取得投资收益收到的现金 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.dispfilassetrec` | String | 是 | 处置固定资产、无形资产和其他长期资产 收回的现金净额 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.otherinvrec` | String | 是 | 收到的其他与投资活动有关的现金 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.invflowinbalance` | String | 是 | 投资活动现金流入的平衡项目 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.invflowinother` | String | 是 | 投资活动现金流入的其他项目 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.suminvflowin` | String | 是 | 投资活动现金流入小计 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.disposalinvrec` | String | 是 | 收回投资收到的现金 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.buysellbackfassetrec` | String | 是 | 收到买入返售金融资产现金净额 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.dispsubsidiaryrec` | String | 是 | 处置子公司及其他营业单位收到的现金 |  |
| `data.items[].jyhdxjlc` | Object | 是 | 经营活动现金流出 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.taxpay` | String | 是 | 支付的各项税费 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.divipay` | String | 是 | 支付保单红利的现金 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.operateflowoutbalance` | String | 是 | 经营活动现金流出的平衡项目 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.operateflowoutother` | String | 是 | 经营活动现金流出的其他项目 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.ndsellbuyback` | String | 是 | 银行业务及证券业务卖出回购资金净减少额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.employeepay` | String | 是 | 支付给职工以及为职工支付的现金 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.ndinsureddepositinv` | String | 是 | 保户储金及投资款净减少额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.niloanadvances` | String | 是 | 发放贷款及垫款净增加额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.intandcommpay` | String | 是 | 支付利息、手续费及佣金的现金 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.netripay` | String | 是 | 支付再保险业务现金净额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.nibuysellback` | String | 是 | 银行业务及证券业务买入返售资金净增加额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.sumoperateflowout` | String | 是 | 经营活动现金流出小计 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.indemnitypay` | String | 是 | 支付原保险合同赔付等款项的现金 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.ndlendfund` | String | 是 | 银行业务及证券业务拆借资金净减少额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.nidepositincbankfi` | String | 是 | 存放中央银行和同业款项净增加额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.nettradefassetpay` | String | 是 | 支付交易性金融资产现金净额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.otheroperatepay` | String | 是 | 支付其他与经营活动有关的现金 |  |
| `data.items[].czhdcsdxjllje` | Object | 是 | 筹资活动产生的现金流量净额 |  |
| `data.items[].czhdcsdxjllje.czhdcsdxjllje.finaflowbalance` | String | 是 | 筹资活动产生的现金流量净额平衡项目 |  |
| `data.items[].czhdcsdxjllje.czhdcsdxjllje.finaflowother` | String | 是 | 筹资活动产生的现金流量净额其他项目 |  |
| `data.items[].czhdcsdxjllje.czhdcsdxjllje.netfinacashflow` | String | 是 | 筹资活动产生的现金流量净额 |  |
| `data.items[].qmxjjxjdjwye` | Object | 是 | 期末现金及现金等价物余额 |  |
| `data.items[].qmxjjxjdjwye.qmxjjxjdjwye.cashequibeginning` | String | 是 | 期初现金及现金等价物余额 |  |
| `data.items[].qmxjjxjdjwye.qmxjjxjdjwye.cashequiendingother` | String | 是 | 期末现金及现金等价物余额其他项目 |  |
| `data.items[].qmxjjxjdjwye.qmxjjxjdjwye.cashequiending` | String | 是 | 期末现金及现金等价物余额 |  |
| `data.items[].qmxjjxjdjwye.qmxjjxjdjwye.cashequiendingbalan` | String | 是 | 期末现金及现金等价物余额平衡项目 |  |
| `data.items[].xjjxjdjwjzje` | Object | 是 | 现金及现金等价物净增加额 |  |
| `data.items[].xjjxjdjwjzje.xjjxjdjwjzje.nicashequi` | String | 是 | 现金及现金等价物净增加额 |  |
| `data.items[].xjjxjdjwjzje.xjjxjdjwjzje.nicashequibalance` | String | 是 | 现金及现金等价物净增加额平衡项目 |  |
| `data.items[].xjjxjdjwjzje.xjjxjdjwjzje.nicashequiother` | String | 是 | 现金及现金等价物净增加额其他项目 |  |
| `data.items[].hlbddxjjxjdjwdyx` | Object | 是 | 汇率变动对现金及现金等价物的影响 |  |
| `data.items[].hlbddxjjxjdjwdyx.effectexchangerate` | String | 是 | 汇率变动对现金及现金等价物的影响 |  |
| `data.items[].jyhdxjlr` | Object | 是 | 经营活动现金流入 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.nisellbuyback` | String | 是 | 银行及证券业务卖出回购资金净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.nideposit` | String | 是 | 客户存款和同业存放款项净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.taxreturnrec` | String | 是 | 收到的税收返还 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.operateflowinbalance` | String | 是 | 经营活动现金流入的平衡项目 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.intandcommrec` | String | 是 | 收取利息、手续费及佣金的现金 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.nilendfund` | String | 是 | 银行业务及证券业务拆借资金净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.sumoperateflowin` | String | 是 | 经营活动现金流入小计 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.operateflowinother` | String | 是 | 经营活动现金流入的其他项目 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.netrirec` | String | 是 | 收到再保险业务现金净额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.otheroperaterec` | String | 是 | 收到其他与经营活动有关的现金 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.nettradefassetrec` | String | 是 | 收到交易性金融资产现金净额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.ndbuysellback` | String | 是 | 银行及证券业务买入返售资金净减少额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.premiumrec` | String | 是 | 收到原保险合同保费取得的现金 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.niinsureddepositinv` | String | 是 | 保户储金及投资款净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.nddepositincbankfi` | String | 是 | 存放中央银行和同业款项净减少额 |  |
| `data.items[].czhdxjlc` | Object | 是 | 筹资活动现金流出 |  |
| `data.items[].czhdxjlc.czhdxjlc.finaflowoutbalance` | String | 是 | 筹资活动现金流出的平衡项目 |  |
| `data.items[].czhdxjlc.czhdxjlc.finaflowoutother` | String | 是 | 筹资活动现金流出的其他项目 |  |
| `data.items[].czhdxjlc.czhdxjlc.sumfinaflowout` | String | 是 | 筹资活动现金流出小计 |  |
| `data.items[].czhdxjlc.czhdxjlc.repaydebtpay` | String | 是 | 偿还债务所支付的现金 |  |
| `data.items[].czhdxjlc.czhdxjlc.otherfinapay` | String | 是 | 支付的其他与筹资活动有关的现金 |  |
| `data.items[].czhdxjlc.czhdxjlc.netsellbuybackfassetpay` | String | 是 | 支付卖出回购金融资产款现金净额 |  |
| `data.items[].czhdxjlc.czhdxjlc.diviprofitorintpay` | String | 是 | 分配股利、利润或偿付利息支付的现金 |  |
| `data.items[].tzhdcsdxjllje` | Object | 是 | 投资活动产生的现金流量净额 |  |
| `data.items[].tzhdcsdxjllje.tzhdcsdxjllje.netinvcashflow` | String | 是 | 投资活动产生的现金流量净额 |  |
| `data.items[].tzhdcsdxjllje.tzhdcsdxjllje.invflowother` | String | 是 | 投资活动产生的现金流量净额其他项目 |  |
| `data.items[].tzhdcsdxjllje.tzhdcsdxjllje.invcashflowbalance` | String | 是 | 投资活动产生的现金流量净额平衡项目 |  |
| `data.items[].tzhdxjlc` | Object | 是 | 投资活动现金流出 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.dispsubsidiarypay` | String | 是 | 处置子公司及其他营业单位流出的现金净额 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.invflowoutother` | String | 是 | 投资活动现金流出的其他项目 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.invpay` | String | 是 | 投资支付的现金 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.otherinvpay` | String | 是 | 支付其他与投资活动有关的现金 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.niinsuredpledgeloan` | String | 是 | 保户质押贷款净增加额 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.buysubsidiarypay` | String | 是 | 收购子公司及其他营业单位支付的现金净额 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.invflowoutbalance` | String | 是 | 投资活动现金流出的平衡项目 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.buysellbackfassetpay` | String | 是 | 支付买入返售金融资产现金净额 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.suminvflowout` | String | 是 | 投资活动现金流出小计 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.buyfilassetpay` | String | 是 | 购建固定资产、无形资产和其他长期资产所支付的现金 |  |
| `data.items[].format_reportdate` | String | 是 | 格式化上报日期 |  |
| `data.items[].reportdate` | String | 是 | 上报日期。fntype=127000000606280264 |  |
| `data.items[].fntype` | String | 是 | 127000000606280264 |  |
| `data.items[].jyhdxjlc` | Object | 是 | 经营活动现金流出 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.taxpay` | String | 是 | 支付的各项税费 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.nidepositincbank` | String | 是 | 存放中央银行款项净增加额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.intpay` | String | 是 | 支付利息的现金 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.ndfideposit` | String | 是 | 同业及其他机构存放款减少净额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.operateflowoutbalance` | String | 是 | 经营活动现金流出的平衡项目 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.nitradefasset` | String | 是 | 交易性金融资产净增加额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.ndborrowsellbuyback` | String | 是 | 拆入资金及卖出回购金融资产款净减少 额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.nidepositinfi` | String | 是 | 存放同业及其他金融机构款项净增加额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.ndissuecd` | String | 是 | 已发行存款证净减少额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.nilendsellbuyback` | String | 是 | 拆出资金及买入返售金融资产净增加额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.ndborrowfromcbank` | String | 是 | 向中央银行借款净减少额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.buyfinaleaseassetpay` | String | 是 | 购买融资租赁资产支付的现金 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.nibuysellbackfasset` | String | 是 | 买入返售金融资产净增加额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.ndtradefliab` | String | 是 | 交易性金融负债净减少额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.operateflowoutother` | String | 是 | 经营活动现金流出的其他项目 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.nidepositincbankfi` | String | 是 | 存放中央银行和同业及其他金融机构款 项净增加额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.intandcommpay` | String | 是 | 支付利息、手续费及佣金的现金 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.otheroperatepay` | String | 是 | 支付其他与经营活动有关的现金 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.ndsellbuybackfasset` | String | 是 | 卖出回购金融资产净减少额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.niaccountrec` | String | 是 | 应收账款净增加额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.sumoperateflowout` | String | 是 | 经营活动现金流出小计 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.employeepay` | String | 是 | 支付给职工以及为职工支付的现金 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.nilendfund` | String | 是 | 拆出资金净增加额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.niloanadvances` | String | 是 | 客户贷款及垫款净增加额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.ndborrowfund` | String | 是 | 拆入资金净减少额 |  |
| `data.items[].jyhdxjlc.jyhdxjlc.commpay` | String | 是 | 支付手续费及佣金的现金 |  |
| `data.items[].czhdxjlr` | Object | 是 | 筹资活动现金流入 |  |
| `data.items[].czhdxjlr.czhdxjlr.issueotherbondrec` | String | 是 | 发行其他债券所收到的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.addsharecapitalrec` | String | 是 | 增加股本所收到的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.issuebondrec` | String | 是 | 发行债券收到的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.finaflowinother` | String | 是 | 筹资活动现金流入的其他项目 |  |
| `data.items[].czhdxjlr.czhdxjlr.subsidiaryaccept` | String | 是 | 子公司吸收少数股东投资收到的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.issuejuniorbondrec` | String | 是 | 发行次级债券所收到的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.sumfinaflowin` | String | 是 | 筹资活动现金流入小计 |  |
| `data.items[].czhdxjlr.czhdxjlr.finaflowinbalance` | String | 是 | 筹资活动现金流入的平衡项目 |  |
| `data.items[].czhdxjlr.czhdxjlr.acceptinvrec` | String | 是 | 吸收投资所收到的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.otherfinarec` | String | 是 | 收到其他与筹资活动有关的现金 |  |
| `data.items[].czhdxjlr.czhdxjlr.issuecd` | String | 是 | 发行存款证 |  |
| `data.items[].jyhdcsdxjllje` | Object | 是 | 经营活动产生的现金流量净额 |  |
| `data.items[].jyhdcsdxjllje.jyhdcsdxjllje.operateflowbalance` | String | 是 | 经营活动产生的现金流量净额平衡项目 |  |
| `data.items[].jyhdcsdxjllje.jyhdcsdxjllje.operateflowother` | String | 是 | 经营活动产生的现金流量净额其他项目 |  |
| `data.items[].jyhdcsdxjllje.jyhdcsdxjllje.netoperatecashflow` | String | 是 | 经营活动产生的现金流量净额 |  |
| `data.items[].tzhdxjlr` | Object | 是 | 投资活动现金流入 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.diviorprofitrec` | String | 是 | 分得股利或利润所收到的现金 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.dispfilassetrec` | String | 是 | 处置固定资产、无形资产和其他长期资产 收回的现金 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.otherinvrec` | String | 是 | 收到其他与投资活动有关的现金 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.invflowinbalance` | String | 是 | 投资活动现金流入的平衡项目 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.invflowinother` | String | 是 | 投资活动现金流入的其他项目 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.suminvflowin` | String | 是 | 投资活动现金流入小计 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.disposalinvrec` | String | 是 | 收回投资收到的现金 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.invincomerec` | String | 是 | 取得投资收益收到的现金 |  |
| `data.items[].tzhdxjlr.tzhdxjlr.dispsubsidiaryrec` | String | 是 | 处置子公司、联营企业及合营企业投资及 其他企业收到的现金 |  |
| `data.items[].czhdcsdxjllje` | Object | 是 | 筹资活动产生的现金流量净额 |  |
| `data.items[].czhdcsdxjllje.czhdcsdxjllje.finaflowbalance` | String | 是 | 筹资活动产生的现金流量净额平衡项目 |  |
| `data.items[].czhdcsdxjllje.czhdcsdxjllje.finaflowother` | String | 是 | 筹资活动产生的现金流量净额其他项目 |  |
| `data.items[].czhdcsdxjllje.czhdcsdxjllje.netfinacashflow` | String | 是 | 筹资活动产生的现金流量净额 |  |
| `data.items[].qmxjjxjdjwye` | Object | 是 | 期末现金及现金等价物余额 |  |
| `data.items[].qmxjjxjdjwye.qmxjjxjdjwye.cashequibeginning` | String | 是 | 期初现金及现金等价物余额 |  |
| `data.items[].qmxjjxjdjwye.qmxjjxjdjwye.cashequiendingother` | String | 是 | 期末现金及现金等价物余额其他项目 |  |
| `data.items[].qmxjjxjdjwye.qmxjjxjdjwye.cashequiending` | String | 是 | 期末现金及现金等价物余额 |  |
| `data.items[].qmxjjxjdjwye.qmxjjxjdjwye.cashequiendingbalan` | String | 是 | 期末现金及现金等价物余额平衡项目 |  |
| `data.items[].xjjxjdjwjzje` | Object | 是 | 现金及现金等价物净增加额 |  |
| `data.items[].xjjxjdjwjzje.xjjxjdjwjzje.nicashequi` | String | 是 | 现金及现金等价物净增加额 |  |
| `data.items[].xjjxjdjwjzje.xjjxjdjwjzje.nicashequibalance` | String | 是 | 现金及现金等价物净增加额平衡项目 |  |
| `data.items[].xjjxjdjwjzje.xjjxjdjwjzje.nicashequiother` | String | 是 | 现金及现金等价物净增加额其他项目 |  |
| `data.items[].hlbddxjjxjdjwdyx` | Object | 是 | 汇率变动对现金及现金等价物的影响 |  |
| `data.items[].hlbddxjjxjdjwdyx.effectexchangerate` | String | 是 | 汇率变动对现金及现金等价物的影响 |  |
| `data.items[].tzhdxjlc` | Object | 是 | 投资活动现金流出 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.otherinvpay` | String | 是 | 支付的其他与投资活动有关的现金 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.suminvflowout` | String | 是 | 投资活动现金流出小计 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.getsubsidiarypay` | String | 是 | 取得子公司及其他营业单位支付的现金 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.buyfilassetpay` | String | 是 | 购建固定资产、无形资产和其他长期资产支付的现金 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.invflowoutother` | String | 是 | 投资活动现金流出的其他项目 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.invpay` | String | 是 | 投资支付的现金 |  |
| `data.items[].tzhdxjlc.tzhdxjlc.invflowoutbalance` | String | 是 | 投资活动现金流出的平衡项目 |  |
| `data.items[].tzhdcsdxjllje` | Object | 是 | 投资活动产生的现金流量净额 |  |
| `data.items[].tzhdcsdxjllje.tzhdcsdxjllje.invflowbalance` | String | 是 | 投资活动产生的现金流量净额平衡项目 |  |
| `data.items[].tzhdcsdxjllje.tzhdcsdxjllje.invflowother` | String | 是 | 投资活动产生的现金流量净额其他项目 |  |
| `data.items[].tzhdcsdxjllje.tzhdcsdxjllje.netinvcashflow` | String | 是 | 投资活动产生的现金流量净额 |  |
| `data.items[].czhdxjlc` | Object | 是 | 筹资活动现金流出 |  |
| `data.items[].czhdxjlc.czhdxjlc.finaflowoutbalance` | String | 是 | 筹资活动现金流出的平衡项目 |  |
| `data.items[].czhdxjlc.czhdxjlc.finaflowoutother` | String | 是 | 筹资活动现金流出的其他项目 |  |
| `data.items[].czhdxjlc.czhdxjlc.sumfinaflowout` | String | 是 | 筹资活动现金流出小计 |  |
| `data.items[].czhdxjlc.czhdxjlc.issuesharerec` | String | 是 | 股份发行支付的费用 |  |
| `data.items[].czhdxjlc.czhdxjlc.repaydebtpay` | String | 是 | 偿还债务支付的现金 |  |
| `data.items[].czhdxjlc.czhdxjlc.otherfinapay` | String | 是 | 支付其他与筹资活动有关的现金 |  |
| `data.items[].czhdxjlc.czhdxjlc.bondintpay` | String | 是 | 偿付债券利息支付的现金 |  |
| `data.items[].czhdxjlc.czhdxjlc.diviprofitorintpay` | String | 是 | 分配股利、利润或偿付利息支付的现金 |  |
| `data.items[].jyhdxjlr` | Object | 是 | 经营活动产生的现金流入 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.niborrowsellbuyback` | String | 是 | 拆入资金及卖出回购金融资产款净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.nideposit` | String | 是 | 客户存款和同业及其他金融机构存放款项净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.nisellbuybackfasset` | String | 是 | 卖出回购金融资产款净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.netcd` | String | 是 | 存款证净额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.ndbuysellbackfasset` | String | 是 | 买入返售金融资产净减少额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.niclientdeposit` | String | 是 | 客户存款净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.niborrowfund` | String | 是 | 拆入资金净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.cancelloanrec` | String | 是 | 收回的已于以前年度核销的贷款 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.nitradefliab` | String | 是 | 交易性金融负债净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.niborrowfromcbank` | String | 是 | 向中央银行借款净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.nddepositincbankfi` | String | 是 | 存放中央银行和同业款项及其他金融机构净减少额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.sumoperateflowin` | String | 是 | 经营活动现金流入小计 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.operateflowinbalance` | String | 是 | 经营活动现金流入的平衡项目 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.operateflowinother` | String | 是 | 经营活动现金流入的其他项目 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.intandcommrec` | String | 是 | 收取的利息、手续费及佣金的现金 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.nddepositinfi` | String | 是 | 存放同业及其他金融机构款项净减少额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.nddepositincbank` | String | 是 | 存放中央银行款项净减少额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.otheroperaterec` | String | 是 | 收到的其他与经营活动有关的现金 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.ndlendfund` | String | 是 | 拆出资金净减少额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.dispmassetrec` | String | 是 | 处置抵债资产收到的现金 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.commrec` | String | 是 | 收取手续费及佣金的现金 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.intrec` | String | 是 | 收取利息的现金 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.ndlendbuysellback` | String | 是 | 拆出资金及买入返售金融资产净减少额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.nifideposit` | String | 是 | 同业及其他金融机构存放款项净增加额 |  |
| `data.items[].jyhdxjlr.jyhdxjlr.ndtradefasset` | String | 是 | 交易性金融资产净减少额 |  |

### 68.18 利润表

- Hub：`POST /api/v1/data/enterprise/68.18/query`；上游方法 GET；可调用
- 说明：上市企业利润表信息，包括营业支出、利润总额、每股收益、营业利润、综合收益总额和营业收入等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前10条，取11到20条的数据，skip=10，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.fntype` | String | 是 | 类型 127000000606280264：银行 127000000606280720：保险 127000000606281107：证券 127000000606281483：通用 |  |
| `data.items` | Array | 是 | 财务指标信息列表 |  |
| `data.items[].reportdate` | String | 是 | 上报日期 |  |
| `data.items[].format_reportdate` | String | 是 | 格式化上报日期 |  |
| `data.items[].fntype` | String | 是 | 类型，127000000606280264 |  |
| `data.items[].yyzc` | Object | 是 | 营业支出 |  |
| `data.items[].yyzc.miotherincome` | String | 是 | 其他收益 |  |
| `data.items[].yyzc.creddevalueloss` | String | 是 | 信用减值损失 |  |
| `data.items[].yyzc.adisposalincome` | String | 是 | 资产处置收益 |  |
| `data.items[].yyzc.operateprofitbalance` | String | 是 | 营业利润平衡项目 |  |
| `data.items[].yyzc.operatemanageexp` | String | 是 | 业务及管理费 |  |
| `data.items[].yyzc.operateexp` | String | 是 | 营业支出 |  |
| `data.items[].yyzc.operateprofitother` | String | 是 | 营业利润其他项目 |  |
| `data.items[].yyzc.operateexpother` | String | 是 | 营业支出其他项目 |  |
| `data.items[].yyzc.operatetax` | String | 是 | 营业税金及附加 |  |
| `data.items[].yyzc.assetdevalueloss` | String | 是 | 资产减值损失 |  |
| `data.items[].yyzc.operateexpbalance` | String | 是 | 营业支出平衡项目 |  |
| `data.items[].yyzc.otherexp` | String | 是 | 其他业务成本 |  |
| `data.items[].lrze` | Object | 是 | 利润总额 |  |
| `data.items[].lrze.sumprofit` | String | 是 | 利润总额 |  |
| `data.items[].lrze.incometax` | String | 是 | 所得税费用 |  |
| `data.items[].lrze.netprofitother1` | String | 是 | 影响净利润的其他项目 |  |
| `data.items[].lrze.netprofitbalance1` | String | 是 | 净利润平衡项目1 |  |
| `data.items[].mgsy` | Object | 是 | 每股收益 |  |
| `data.items[].mgsy.dilutedeps` | String | 是 | 稀释每股收益 |  |
| `data.items[].mgsy.basiceps` | String | 是 | 基本每股收益 |  |
| `data.items[].yylr` | Object | 是 | 营业利润 |  |
| `data.items[].yylr.sumprofitother` | String | 是 | 影响利润总额的其他项目 |  |
| `data.items[].yylr.nonoperatereve` | String | 是 | 营业外收入 |  |
| `data.items[].yylr.sumprofitbalance` | String | 是 | 利润总额平衡项目 |  |
| `data.items[].yylr.nonoperateexp` | String | 是 | 营业外支出 |  |
| `data.items[].yylr.operateprofit` | String | 是 | 营业利润 |  |
| `data.items[].zhsyze` | Object | 是 | 综合收益总额 |  |
| `data.items[].zhsyze.sumcincome` | String | 是 | 综合收益总额 |  |
| `data.items[].zhsyze.minoritycincome` | String | 是 | 归属于少数股东的综合收益总额 |  |
| `data.items[].zhsyze.parentcincome` | String | 是 | 归属于母公司股东的综合收益总额 |  |
| `data.items[].zhsyze.cincomebalance2` | String | 是 | 综合收益平衡项目2 |  |
| `data.items[].yysr` | Object | 是 | 营业收入 |  |
| `data.items[].yysr.commexp` | String | 是 | 手续费及佣金支出 |  |
| `data.items[].yysr.commnreve` | String | 是 | 手续费及佣金净收入 |  |
| `data.items[].yysr.commreve` | String | 是 | 手续费及佣金收入 |  |
| `data.items[].yysr.intnreve` | String | 是 | 利息净收入 |  |
| `data.items[].yysr.intreve` | String | 是 | 利息收入 |  |
| `data.items[].yysr.intexp` | String | 是 | 利息支出 |  |
| `data.items[].yysr.otherreve` | String | 是 | 其他业务收入 |  |
| `data.items[].yysr.revebalance` | String | 是 | 营业收入平衡项目 |  |
| `data.items[].yysr.operatereve` | String | 是 | 营业收入 |  |
| `data.items[].yysr.reveother` | String | 是 | 营业收入其他项目 |  |
| `data.items[].yysr.exchangeincome` | String | 是 | 汇兑收益 |  |
| `data.items[].yysr.fvalueincome` | String | 是 | 公允价值变动收益 |  |
| `data.items[].yysr.investjointincome` | String | 是 | 对联营企业和合营企业的投资收益 |  |
| `data.items[].yysr.investincome` | String | 是 | 投资收益 |  |
| `data.items[].qtzhsy` | Object | 是 | 其他综合收益 |  |
| `data.items[].qtzhsy.cincomebalance1` | String | 是 | 综合收益平衡项目1 |  |
| `data.items[].qtzhsy.othercincome` | String | 是 | 其他综合收益 |  |
| `data.items[].jlr` | Object | 是 | 净利润 |  |
| `data.items[].jlr.continuousonprofit` | String | 是 | 持续经营净利润 |  |
| `data.items[].jlr.terminationonprofit` | String | 是 | 终止经营净利润 |  |
| `data.items[].jlr.netprofitother2` | String | 是 | 净利润其他项目 |  |
| `data.items[].jlr.minorityincome` | String | 是 | 少数股东损益 |  |
| `data.items[].jlr.netprofit` | String | 是 | 净利润 |  |
| `data.items[].jlr.parentnetprofit` | String | 是 | 归属于母公司股东的净利润 |  |
| `data.items[].jlr.netprofitbalance2` | String | 是 | 净利润平衡项目2 |  |
| `data.items[].reportdate` | String | 是 | 上报日期，fntype = "127000000606280720" |  |
| `data.items[].format_reportdate` | String | 是 | 格式化上报日期 |  |
| `data.items[].fntype` | String | 是 | 类型，127000000606280720 |  |
| `data.items[].yyzc` | Object | 是 | 营业支出 |  |
| `data.items[].yyzc.miotherincome` | String | 是 | 其他收益 |  |
| `data.items[].yyzc.creddevalueloss` | String | 是 | 信用减值损失 |  |
| `data.items[].yyzc.adisposalincome` | String | 是 | 资产处置收益 |  |
| `data.items[].yyzc.operateprofitbalance` | String | 是 | 营业利润平衡项目 |  |
| `data.items[].yyzc.operatemanageexp` | String | 是 | 业务及管理费 |  |
| `data.items[].yyzc.operateexp` | String | 是 | 营业支出 |  |
| `data.items[].yyzc.operateprofitother` | String | 是 | 营业利润其他项目 |  |
| `data.items[].yyzc.operateexpother` | String | 是 | 营业支出其他项目 |  |
| `data.items[].yyzc.operatetax` | String | 是 | 营业税金及附加 |  |
| `data.items[].yyzc.assetdevalueloss` | String | 是 | 资产减值损失 |  |
| `data.items[].yyzc.operateexpbalance` | String | 是 | 营业支出平衡项目 |  |
| `data.items[].yyzc.otherexp` | String | 是 | 其他业务成本 |  |
| `data.items[].yyzc.amortiseriexp` | String | 是 | 摊回分保费用 |  |
| `data.items[].yyzc.surrenderpremium` | String | 是 | 退保金 |  |
| `data.items[].yyzc.amortiseindemnityexp` | String | 是 | 摊回赔付支出 |  |
| `data.items[].yyzc.policydiviexp` | String | 是 | 保单红利支出 |  |
| `data.items[].yyzc.commexp` | String | 是 | 手续费及佣金支出 |  |
| `data.items[].yyzc.riexp` | String | 是 | 分保费用 |  |
| `data.items[].yyzc.intexp` | String | 是 | 利息支出 |  |
| `data.items[].yyzc.indemnityexp` | String | 是 | 赔付支出 |  |
| `data.items[].yyzc.financeexp` | String | 是 | 财务费用 |  |
| `data.items[].yyzc.dutyreserve` | String | 是 | 提取保险责任准备金 |  |
| `data.items[].yyzc.amortisedutyreserve` | String | 是 | 摊回保险责任准备金 |  |
| `data.items[].lrze` | Object | 是 | 利润总额 |  |
| `data.items[].lrze.sumprofit` | String | 是 | 利润总额 |  |
| `data.items[].lrze.incometax` | String | 是 | 所得税费用 |  |
| `data.items[].lrze.netprofitother1` | String | 是 | 影响净利润的其他项目 |  |
| `data.items[].lrze.netprofitbalance1` | String | 是 | 净利润平衡项目1 |  |
| `data.items[].mgsy` | Object | 是 | 每股收益 |  |
| `data.items[].mgsy.dilutedeps` | String | 是 | 稀释每股收益 |  |
| `data.items[].mgsy.basiceps` | String | 是 | 基本每股收益 |  |
| `data.items[].yylr` | Object | 是 | 营业利润 |  |
| `data.items[].yylr.sumprofitother` | String | 是 | 影响利润总额的其他项目 |  |
| `data.items[].yylr.nonoperatereve` | String | 是 | 营业外收入 |  |
| `data.items[].yylr.sumprofitbalance` | String | 是 | 利润总额平衡项目 |  |
| `data.items[].yylr.nonoperateexp` | String | 是 | 营业外支出t |  |
| `data.items[].yylr.operateprofit` | String | 是 | 营业利润 |  |
| `data.items[].zhsyze` | Object | 是 | 综合收益总额 |  |
| `data.items[].zhsyze.sumcincome` | String | 是 | 综合收益总额 |  |
| `data.items[].zhsyze.minoritycincome` | String | 是 | 归属于少数股东的综合收益总额 |  |
| `data.items[].zhsyze.parentcincome` | String | 是 | 归属于母公司股东的综合收益总额 |  |
| `data.items[].zhsyze.cincomebalance2` | String | 是 | 综合收益平衡项目2 |  |
| `data.items[].zhsyze.cincomebalance1` | String | 是 | 综合收益平衡项目1 |  |
| `data.items[].yysr` | Object | 是 | 营业收入 |  |
| `data.items[].yysr.insurreve` | String | 是 | 保险业务收入 |  |
| `data.items[].yysr.investincome` | String | 是 | 投资收益 |  |
| `data.items[].yysr.reveother` | String | 是 | 营业收入其他项目 |  |
| `data.items[].yysr.bankintreve` | String | 是 | 银行业务利息收入 |  |
| `data.items[].yysr.ninsurcommexp` | String | 是 | 非保险业务手续费及佣金支出 |  |
| `data.items[].yysr.rireve` | String | 是 | 分保费收入 |  |
| `data.items[].yysr.revebalance` | String | 是 | 营业收入平衡项目 |  |
| `data.items[].yysr.operatereve` | String | 是 | 营业收入 |  |
| `data.items[].yysr.ninsurcommreve` | String | 是 | 非保险业务手续费及佣金收入 |  |
| `data.items[].yysr.otherreve` | String | 是 | 其他业务收入 |  |
| `data.items[].yysr.bankintexp` | String | 是 | 银行业务利息支出 |  |
| `data.items[].yysr.unduereserve` | String | 是 | 提取未到期责任准备金 |  |
| `data.items[].yysr.fvalueincome` | String | 是 | 公允价值变动损益 |  |
| `data.items[].yysr.premiumearned` | String | 是 | 已赚保费 |  |
| `data.items[].yysr.ninsurcommnreve` | String | 是 | 非保险业务手续费及佣金净收入 |  |
| `data.items[].yysr.premiumearnedbalance` | String | 是 | 已赚保费平衡项目 |  |
| `data.items[].yysr.investjointincome` | String | 是 | 对联营企业和合营企业的投资收益/（损失） |  |
| `data.items[].yysr.ripremium` | String | 是 | 分出保费 |  |
| `data.items[].yysr.exchangeincome` | String | 是 | 汇兑损失 |  |
| `data.items[].yysr.bankintnreve` | String | 是 | 银行业务利息净收入 |  |
| `data.items[].qtzhsy` | Object | 是 | 其他综合收益 |  |
| `data.items[].qtzhsy.parothcinother` | String | 是 | 归属母公司所有者的其他综合收益其他项目 |  |
| `data.items[].qtzhsy.parentothercincome` | String | 是 | 归属于母公司股东的其他综合收益 |  |
| `data.items[].qtzhsy.othercincome` | String | 是 | 其他综合收益 |  |
| `data.items[].qtzhsy.minorityothercincome` | String | 是 | 归属于少数股东的其他综合收益 |  |
| `data.items[].qtzhsy.othercincomeother` | String | 是 | 其他综合收益其他项目 |  |
| `data.items[].qtzhsy.othercincomebalance` | String | 是 | 其他综合收益平衡项目 |  |
| `data.items[].qtzhsy.parothcinbala` | String | 是 | 归属母公司所有者的其他综合收益平衡项目 |  |
| `data.items[].jlr` | Object | 是 | 净利润 |  |
| `data.items[].jlr.continuousonprofit` | String | 是 | 持续经营净利润 |  |
| `data.items[].jlr.terminationonprofit` | String | 是 | 终止经营净利润 |  |
| `data.items[].jlr.netprofitother2` | String | 是 | 净利润其他项目 |  |
| `data.items[].jlr.minorityincome` | String | 是 | 少数股东损益 |  |
| `data.items[].jlr.netprofit` | String | 是 | 净利润 |  |
| `data.items[].jlr.parentnetprofit` | String | 是 | 归属于母公司股东的净利润 |  |
| `data.items[].jlr.netprofitbalance2` | String | 是 | 净利润平衡项目，2fntype ="127000000606280720" |  |
| `data.items[].reportdate` | String | 是 | 上报日期，fntype = "127000000606281107" |  |
| `data.items[].format_reportdate` | String | 是 | 格式化上报日期 |  |
| `data.items[].fntype` | String | 是 | 类型，127000000606281107 |  |
| `data.items[].fntype.yyzc` | Object | 是 | 营业支出 |  |
| `data.items[].fntype.yyzc.miotherincome` | String | 是 | 其他收益 |  |
| `data.items[].fntype.yyzc.creddevalueloss` | String | 是 | 信用减值损失 |  |
| `data.items[].fntype.yyzc.adisposalincome` | String | 是 | 资产处置收益 |  |
| `data.items[].fntype.yyzc.operateprofitbalance` | String | 是 | 营业利润平衡项目 |  |
| `data.items[].fntype.yyzc.operatemanageexp` | String | 是 | 业务及管理费 |  |
| `data.items[].fntype.yyzc.operateexp` | String | 是 | 营业支出 |  |
| `data.items[].fntype.yyzc.operateprofitother` | String | 是 | 营业利润其他项目 |  |
| `data.items[].fntype.yyzc.operateexpother` | String | 是 | 营业支出其他项目 |  |
| `data.items[].fntype.yyzc.operatetax` | String | 是 | 营业税金及附加 |  |
| `data.items[].fntype.yyzc.assetdevalueloss` | String | 是 | 资产减值损失 |  |
| `data.items[].fntype.yyzc.operateexpbalance` | String | 是 | 营业支出平衡项目 |  |
| `data.items[].fntype.yyzc.otherexp` | String | 是 | 其他业务成本 |  |
| `data.items[].fntype.lrze` | Object | 是 | 利润总额 |  |
| `data.items[].fntype.lrze.sumprofit` | String | 是 | 利润总额 |  |
| `data.items[].fntype.lrze.incometax` | String | 是 | 所得税费用 |  |
| `data.items[].fntype.lrze.netprofitother1` | String | 是 | 影响净利润的其他项目 |  |
| `data.items[].fntype.lrze.netprofitbalance1` | String | 是 | 净利润平衡项目1 |  |
| `data.items[].fntype.mgsy` | Object | 是 | 每股收益 |  |
| `data.items[].fntype.mgsy.dilutedeps` | String | 是 | 稀释每股收益 |  |
| `data.items[].fntype.mgsy.basiceps` | String | 是 | 基本每股收益 |  |
| `data.items[].fntype.yylr` | Object | 是 | 营业利润 |  |
| `data.items[].fntype.yylr.sumprofitother` | String | 是 | 影响利润总额的其他项目 |  |
| `data.items[].fntype.yylr.nonoperatereve` | String | 是 | 营业外收入 |  |
| `data.items[].fntype.yylr.sumprofitbalance` | String | 是 | 利润总额平衡项目 |  |
| `data.items[].fntype.yylr.nonoperateexp` | String | 是 | 营业外支出t |  |
| `data.items[].fntype.yylr.operateprofit` | String | 是 | 营业利润 |  |
| `data.items[].fntype.zhsyze` | Object | 是 | 综合收益总额 |  |
| `data.items[].fntype.zhsyze.sumcincome` | String | 是 | 综合收益总额 |  |
| `data.items[].fntype.zhsyze.minoritycincome` | String | 是 | 归属于少数股东的综合收益总额 |  |
| `data.items[].fntype.zhsyze.parentcincome` | String | 是 | 归属于母公司股东的综合收益总额 |  |
| `data.items[].fntype.zhsyze.cincomebalance2` | String | 是 | 综合收益平衡项目2 |  |
| `data.items[].fntype.yysr` | Object | 是 | 营业收入 |  |
| `data.items[].fntype.yysr.commnreve` | String | 是 | 手续费及佣金净收入 |  |
| `data.items[].fntype.yysr.reveother` | String | 是 | 营业收入其他项目 |  |
| `data.items[].fntype.yysr.securitybroker` | String | 是 | 证券经纪业务净收入 |  |
| `data.items[].fntype.yysr.commnreveother` | String | 是 | 手续费及佣金净收入其他项目 |  |
| `data.items[].fntype.yysr.clientassetmanage` | String | 是 | 受托客户资产管理业务净收入 |  |
| `data.items[].fntype.yysr.exchangeincome` | String | 是 | 汇兑收益 |  |
| `data.items[].fntype.yysr.fvalueincome` | String | 是 | 公允价值变动收益 |  |
| `data.items[].fntype.yysr.investjointincome` | String | 是 | 对联营企业和合营企业的投资收益 |  |
| `data.items[].fntype.yysr.agenttradesecurity` | String | 是 | 代理买卖证券业务净收入 |  |
| `data.items[].fntype.yysr.finaconsult` | String | 是 | 财务顾问净收入 |  |
| `data.items[].fntype.yysr.intnreve` | String | 是 | 利息净收入 |  |
| `data.items[].fntype.yysr.otherreve` | String | 是 | 其他业务收入 |  |
| `data.items[].fntype.yysr.securityuw` | String | 是 | 证券承销业务净收入 |  |
| `data.items[].fntype.yysr.operatereve` | String | 是 | 营业收入 |  |
| `data.items[].fntype.yysr.sponsor` | String | 是 | 保荐业务净收入 |  |
| `data.items[].fntype.yysr.fundmanage` | String | 是 | 基金管理业务净收入 |  |
| `data.items[].fntype.yysr.revebalance` | String | 是 | 营业收入平衡项目 |  |
| `data.items[].fntype.yysr.investincome` | String | 是 | 投资收益 |  |
| `data.items[].fntype.yysr.fundsale` | String | 是 | 基金销售业务净收入 |  |
| `data.items[].fntype.qtzhsy` | Object | 是 | 其他综合收益 |  |
| `data.items[].fntype.qtzhsy.cincomebalance1` | String | 是 | 综合收益平衡项目1 |  |
| `data.items[].fntype.qtzhsy.minorityothercincome` | String | 是 | 归属于少数股东的其他综合收益 |  |
| `data.items[].fntype.qtzhsy.parentothercincome` | String | 是 | 归属于母公司股东的其他综合收益 |  |
| `data.items[].fntype.qtzhsy.othercincome` | String | 是 | 其他综合收益t |  |
| `data.items[].fntype.jlr` | Object | 是 | 净利润 |  |
| `data.items[].fntype.jlr.terminationonprofit` | String | 是 | 终止经营净利润 |  |
| `data.items[].fntype.jlr.minorityincome` | String | 是 | 少数股东损益 |  |
| `data.items[].fntype.jlr.netprofit` | String | 是 | 净利润 |  |
| `data.items[].fntype.jlr.parentnetprofit` | String | 是 | 归属于母公司股东的净利润 |  |
| `data.items[].fntype.jlr.netprofitother2` | String | 是 | 净利润其他项目 |  |
| `data.items[].fntype.jlr.netprofitbalance2` | String | 是 | 净利润平衡项目2 |  |
| `data.items[].reportdate` | String | 是 | 上报日期，fntype = "127000000606281483" |  |
| `data.items[].format_reportdate` | String | 是 | 格式化上报日期 |  |
| `data.items[].fntype` | String | 是 | 类型，127000000606281483 |  |
| `data.items[].lrze` | Object | 是 | 利润总额 |  |
| `data.items[].lrze.incometax` | String | 是 | 所得税费用 |  |
| `data.items[].lrze.sumprofit` | String | 是 | 利润总额 |  |
| `data.items[].lrze.unconfirminvloss` | String | 是 | 未确认投资损失 |  |
| `data.items[].lrze.netprofitother1` | String | 是 | 影响净利润的其他项目 |  |
| `data.items[].lrze.netprofitbalance1` | String | 是 | 净利润平衡项目1 |  |
| `data.items[].mgsy` | Object | 是 | 每股收益 |  |
| `data.items[].mgsy.dilutedeps` | String | 是 | 稀释每股收益 |  |
| `data.items[].mgsy.basiceps` | String | 是 | 基本每股收益 |  |
| `data.items[].yylr` | Object | 是 | 营业利润 |  |
| `data.items[].yylr.nonoperateexp` | String | 是 | 营业外支出 |  |
| `data.items[].yylr.nonoperatereve` | String | 是 | 营业外收入 |  |
| `data.items[].yylr.nonlassetnetloss` | String | 是 | 非流动资产处置净损失 |  |
| `data.items[].yylr.sumprofitbalance` | String | 是 | 利润总额平衡项目 |  |
| `data.items[].yylr.sumprofitother` | String | 是 | 影响利润总额的其他项目 |  |
| `data.items[].yylr.operateprofit` | String | 是 | 营业利润 |  |
| `data.items[].zhsyze` | Object | 是 | 综合收益总额 |  |
| `data.items[].zhsyze.sumcincome` | String | 是 | 综合收益总额 |  |
| `data.items[].zhsyze.minoritycincome` | String | 是 | 归属于少数股东的综合收益总额 |  |
| `data.items[].zhsyze.parentcincome` | String | 是 | 归属于母公司所有者的综合收益总额 |  |
| `data.items[].zhsyze.cincomebalance2` | String | 是 | 综合收益平衡项目2 |  |
| `data.items[].qtjysy` | Object | 是 | 其他经营收益 |  |
| `data.items[].qtjysy.operateprofitother` | String | 是 | 营业利润其他项目 |  |
| `data.items[].qtjysy.investincome` | String | 是 | 投资收益 |  |
| `data.items[].qtjysy.exchangeincome` | String | 是 | 汇兑收益t |  |
| `data.items[].qtjysy.fvalueincome` | String | 是 | 公允价值变动收益 |  |
| `data.items[].qtjysy.investjointincome` | String | 是 | 对联营企业和合营企业的投资收益 |  |
| `data.items[].qtjysy.operateprofitbalance` | String | 是 | 营业利润平衡项目 |  |
| `data.items[].yysr` | Object | 是 | 营业收入 |  |
| `data.items[].yysr.otherreve` | String | 是 | 其他业务收入 |  |
| `data.items[].yysr.totaloperatereve` | String | 是 | 营业总收入 |  |
| `data.items[].yysr.totaloperatereveother` | String | 是 | 营业总收入其他项目 |  |
| `data.items[].yysr.commreve` | String | 是 | 手续费及佣金收入 |  |
| `data.items[].yysr.intreve` | String | 是 | 利息收入 |  |
| `data.items[].yysr.premiumearned` | String | 是 | 已赚保费 |  |
| `data.items[].yysr.operatereve` | String | 是 | 营业收入 |  |
| `data.items[].yyzcb` | Object | 是 | 营业总成本 |  |
| `data.items[].yyzcb.ofwintexp` | String | 是 | 其中：利息费用 |  |
| `data.items[].yyzcb.ofwintreve` | String | 是 | 其中:利息收入 |  |
| `data.items[].yyzcb.miotherincome` | String | 是 | 其他收益 |  |
| `data.items[].yyzcb.creddevalueloss` | String | 是 | 信用减值损失 |  |
| `data.items[].yyzcb.asset_impairment_income` | String | 是 | 资产减值损失（新） |  |
| `data.items[].yyzcb.adisposalincome` | String | 是 | 资产处置收益 |  |
| `data.items[].yyzcb.totaloperateexp` | String | 是 | 营业总成本 |  |
| `data.items[].yyzcb.financeexp` | String | 是 | 财务费用 |  |
| `data.items[].yyzcb.riexp` | String | 是 | 分保费用 |  |
| `data.items[].yyzcb.netcontactreserve` | String | 是 | 提取保险合同准备金净额 |  |
| `data.items[].yyzcb.intexp` | String | 是 | 利息支出 |  |
| `data.items[].yyzcb.rdexp` | String | 是 | 研发费用t |  |
| `data.items[].yyzcb.manageexp` | String | 是 | 管理费用 |  |
| `data.items[].yyzcb.otherexp` | String | 是 | 其他业务成本 |  |
| `data.items[].yyzcb.commexp` | String | 是 | 手续费及佣金支出 |  |
| `data.items[].yyzcb.totaloperateexpother` | String | 是 | 营业总成本其他项目 |  |
| `data.items[].yyzcb.operateexp` | String | 是 | 营业成本 |  |
| `data.items[].yyzcb.netindemnityexp` | String | 是 | 赔付支出净额t |  |
| `data.items[].yyzcb.saleexp` | String | 是 | 销售费用 |  |
| `data.items[].yyzcb.surrenderpremium` | String | 是 | 退保金t |  |
| `data.items[].yyzcb.operatetax` | String | 是 | 营业税金及附加 |  |
| `data.items[].yyzcb.assetdevalueloss` | String | 是 | 资产减值损失 |  |
| `data.items[].yyzcb.policydiviexp` | String | 是 | 保单红利支出 |  |
| `data.items[].qtzhsy` | Object | 是 | 其他经营收益 |  |
| `data.items[].qtzhsy.cincomebalance1` | String | 是 | 综合收益平衡项目1 |  |
| `data.items[].qtzhsy.minorityothercincome` | String | 是 | 归属于少数股东的其他综合收益 |  |
| `data.items[].qtzhsy.parentothercincome` | String | 是 | 归属于母公司股东的其他综合收益 |  |
| `data.items[].qtzhsy.othercincome` | String | 是 | 其他综合收益t |  |
| `data.items[].jlr` | Object | 是 | 净利润 |  |
| `data.items[].jlr.continuousonprofit` | String | 是 | 持续经营净利润 |  |
| `data.items[].jlr.terminationonprofit` | String | 是 | 终止经营净利润 |  |
| `data.items[].jlr.netprofitother2` | String | 是 | 净利润其他项目 |  |
| `data.items[].jlr.combinednetprofitb` | String | 是 | 被合并方在合并前实现利润 |  |
| `data.items[].jlr.minorityincome` | String | 是 | 少数股东损益 |  |
| `data.items[].jlr.netprofit` | String | 是 | 净利润 |  |
| `data.items[].jlr.parentnetprofit` | String | 是 | 归属于母公司股东的净利润 |  |
| `data.items[].jlr.netprofitbalance2` | String | 是 | 净利润平衡项目，2fntype = "127000000606281483" |  |
| `sign` | String | 否 | 数据签名 |  |

### 68.19 资产负债表

- Hub：`POST /api/v1/data/enterprise/68.19/query`；上游方法 GET；可调用
- 说明：上市企业资产负债表信息，包括所有者权益、股东权益、负债和资产等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前10条，取11到20条的数据，skip=10，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.fntype` | String | 是 | 类型 127000000606280264：银行 127000000606280720：保险 127000000606281107：证券 127000000606281483：通用 |  |
| `data.items` | Object | 是 | 资产负债表信息列表 |  |
| `data.items.reportdate` | String | 是 | 报表日期，报表日期：指上报财务报表的具体日期，fntype = "127000000606280264"银行类型时返回的字段 |  |
| `data.items.format_reportdate` | String | 是 | 报表时间类型，年份+季度/半年度/年度的报表 |  |
| `data.items.fntype` | String | 是 | 127000000606280264 |  |
| `data.items.syzqy` | Object | 是 | 所有者权益 |  |
| `data.items.syzqy.syzqy.generalriskprepare` | String | 是 | 一般风险准备 |  |
| `data.items.syzqy.syzqy.shequity` | String | 是 | 股本 |  |
| `data.items.syzqy.syzqy.surplusreserve` | String | 是 | 盈余公积 |  |
| `data.items.syzqy.syzqy.diffconversionfc` | String | 是 | 外币报表折算差额 |  |
| `data.items.syzqy.syzqy.invrevaluereserve` | String | 是 | 投资重估储备 |  |
| `data.items.syzqy.syzqy.capitalreserve` | String | 是 | 资本公积 |  |
| `data.items.syzqy.syzqy.inventoryshare` | String | 是 | 库存股 |  |
| `data.items.syzqy.syzqy.suggestassigndivi` | String | 是 | 建议分派股利 |  |
| `data.items.syzqy.syzqy.retainedearning` | String | 是 | 未分配利润 |  |
| `data.items.syzqy.syzqy.hedgereserve` | String | 是 | 套期储备 |  |
| `data.items.gdqyhj` | Object | 是 | 股东权益合计 |  |
| `data.items.gdqyhj.gdqyhj.sumshequity` | String | 是 | 股东权益合计 |  |
| `data.items.gdqyhj.gdqyhj.shequityother` | String | 是 | 股东权益其他项目 |  |
| `data.items.gdqyhj.gdqyhj.shequitybalance` | String | 是 | 股东权益平衡项目 |  |
| `data.items.gdqyhj.gdqyhj.minorityequity` | String | 是 | 少数股东权益 |  |
| `data.items.fz` | Object | 是 | 负债 |  |
| `data.items.fz.fz.taxpay` | String | 是 | 应交税费 |  |
| `data.items.fz.fz.acceptdeposit` | String | 是 | 吸收存款 |  |
| `data.items.fz.fz.bondpay` | String | 是 | 应付债券 |  |
| `data.items.fz.fz.liabbalance` | String | 是 | 负债平衡项目 |  |
| `data.items.fz.fz.borrowfund` | String | 是 | 拆入资金 |  |
| `data.items.fz.fz.fideposit` | String | 是 | 同业和其他金融机构存放款项 |  |
| `data.items.fz.fz.dividendpay` | String | 是 | 应付股利 |  |
| `data.items.fz.fz.definefvaluefliab` | String | 是 | 指定以公允价值计量且其变动计入当期损益的金融负债 |  |
| `data.items.fz.fz.outwardremittance` | String | 是 | 汇出汇款 |  |
| `data.items.fz.fz.deferincometaxliab` | String | 是 | 递延所得税负债 |  |
| `data.items.fz.fz.sellbuybackfasset` | String | 是 | 卖出回购金融资产款 |  |
| `data.items.fz.fz.fvaluefliab` | String | 是 | 以公允价值计量且其变动计入当期损益的金融负债 |  |
| `data.items.fz.fz.salarypay` | String | 是 | 应付职工薪酬 |  |
| `data.items.fz.fz.sumliab` | String | 是 | 负债合计 |  |
| `data.items.fz.fz.liabother` | String | 是 | 负债其他项目 |  |
| `data.items.fz.fz.otherliab` | String | 是 | 其他负债 |  |
| `data.items.fz.fz.juniorbondpay` | String | 是 | 应付次级债券 |  |
| `data.items.fz.fz.anticipateliab` | String | 是 | 预计负债 |  |
| `data.items.fz.fz.interestpay` | String | 是 | 应付利息 |  |
| `data.items.fz.fz.tradefliab` | String | 是 | 其中:交易性金融负债 |  |
| `data.items.fz.fz.borrowfromcbank` | String | 是 | 向中央银行借款 |  |
| `data.items.fz.fz.cd` | String | 是 | 存款证 |  |
| `data.items.fz.fz.cdandbillrec` | String | 是 | 存款证及应付票据 |  |
| `data.items.fz.fz.derivefliab` | String | 是 | 衍生金融负债 |  |
| `data.items.fz.fz.trade_finliab_notfvtpl` | String | 是 | 交易性金融负债 |  |
| `data.items.fz.fz.heldsaleliab` | String | 是 | 持有待售负债 |  |
| `data.items.fz.fz.lease_liab` | String | 是 | 租赁负债 |  |
| `data.items.gsymgsgdqyhj` | Object | 是 | 归属于母公司股东权益合计 |  |
| `data.items.gsymgsgdqyhj.gsymgsgdqyhj.parentequityother` | String | 是 | 归属于母公司股东权益其他项目 |  |
| `data.items.gsymgsgdqyhj.gsymgsgdqyhj.parentequitybalance` | String | 是 | 归属于母公司股东权益平衡项目 |  |
| `data.items.gsymgsgdqyhj.gsymgsgdqyhj.sumparentequity` | String | 是 | 归属于母公司股东权益合计 |  |
| `data.items.zc` | Object | 是 | 资产 |  |
| `data.items.zc.zc.lendfund` | String | 是 | 拆出资金 |  |
| `data.items.zc.zc.definefvaluefasset` | String | 是 | 指定为以公允价值计量且其变动计入当期损益的金融资产 |  |
| `data.items.zc.zc.fvaluefasset` | String | 是 | 以公允价值计量且其变动计入当期损益的金融资产 |  |
| `data.items.zc.zc.sumasset` | String | 是 | 资产总计 |  |
| `data.items.zc.zc.fixedasset` | String | 是 | 固定资产 |  |
| `data.items.zc.zc.assetbalance` | String | 是 | 资产平衡项目 |  |
| `data.items.zc.zc.saleablefasset` | String | 是 | 可供出售金融资产 |  |
| `data.items.zc.zc.intangibleasset` | String | 是 | 无形资产 |  |
| `data.items.zc.zc.depositinfi` | String | 是 | 存放同业款项 |  |
| `data.items.zc.zc.masset` | String | 是 | 待处理抵债资产 |  |
| `data.items.zc.zc.invjoint` | String | 是 | 对联营和合营企业的投资 |  |
| `data.items.zc.zc.deferincometaxasset` | String | 是 | 递延所得税资产 |  |
| `data.items.zc.zc.interestrec` | String | 是 | 应收利息 |  |
| `data.items.zc.zc.buysellbackfasset` | String | 是 | 买入返售金融资产 |  |
| `data.items.zc.zc.heldmaturityinv` | String | 是 | 持有至到期投资 |  |
| `data.items.zc.zc.investrec` | String | 是 | 应收款项类投资 |  |
| `data.items.zc.zc.ltequityinv` | String | 是 | 长期股权投资 |  |
| `data.items.zc.zc.estateinvest` | String | 是 | 投资性房地产 |  |
| `data.items.zc.zc.loanadvances` | String | 是 | 发放贷款及垫款 |  |
| `data.items.zc.zc.tradefasset` | String | 是 | 其中:交易性金融资产 |  |
| `data.items.zc.zc.otherasset` | String | 是 | 其他资产 |  |
| `data.items.zc.zc.accountrec` | String | 是 | 应收账款 |  |
| `data.items.zc.zc.constructionprogress` | String | 是 | 在建工程 |  |
| `data.items.zc.zc.cashanddepositcbank` | String | 是 | 现金及存放中央银行款项 |  |
| `data.items.zc.zc.invsubsidiary` | String | 是 | 对子公司的投资 |  |
| `data.items.zc.zc.goodwill` | String | 是 | 商誉 |  |
| `data.items.zc.zc.assetother` | String | 是 | 资产其他项目 |  |
| `data.items.zc.zc.preciousmetal` | String | 是 | 贵金属 |  |
| `data.items.zc.zc.massetdevalue` | String | 是 | 减:抵债资产减值准备 |  |
| `data.items.zc.zc.derivefasset` | String | 是 | 衍生金融资产 |  |
| `data.items.zc.zc.trade_finasset_notfvtpl` | String | 是 | 交易性金融资产 |  |
| `data.items.zc.zc.finance_rece` | String | 是 | 应收款项融资 |  |
| `data.items.zc.zc.heldsaleass` | String | 是 | 持有待售资产 |  |
| `data.items.zc.zc.useright_asset` | String | 是 | 使用权资产 |  |
| `data.items.fzjgdqyzj` | Object | 是 | 负债及股东权益总计 |  |
| `data.items.fzjgdqyzj.fzjgdqyzj.liabshequityother` | String | 是 | 负债和股东权益其他项目 |  |
| `data.items.fzjgdqyzj.fzjgdqyzj.sumliabshequity` | String | 是 | 负债及股东权益总计 |  |
| `data.items.fzjgdqyzj.fzjgdqyzj.liabshequitybalance` | String | 是 | 负债及股东权益平衡项目fntype = "127000000606280264" |  |
| `data.items.reportdate` | String | 是 | 报表日期，报表日期：指上报财务报表的具体日期，，fntype = "127000000606280720"类型为保险时返回的字段 |  |
| `data.items.format_reportdate` | String | 是 | 报表时间类型，年份+季度/半年度/年度的报表 |  |
| `data.items.fntype` | String | 是 | 127000000606280720 |  |
| `data.items.zc` | Object | 是 | 资产 |  |
| `data.items.zc.zc.monetaryfund` | String | 是 | 货币资金 |  |
| `data.items.zc.zc.settlementprovision` | String | 是 | 结算备付金 |  |
| `data.items.zc.zc.lendfund` | String | 是 | 拆出资金 |  |
| `data.items.zc.zc.fvaluefasset` | String | 是 | 以公允价值计量且其变动计入当期损益的金融资产 |  |
| `data.items.zc.zc.tradefasset` | String | 是 | 其中:交易性金融资产 |  |
| `data.items.zc.zc.definefvaluefasset` | String | 是 | 指定以公允价值计量且其变动计入当期损益的金融资产 |  |
| `data.items.zc.zc.derivefasset` | String | 是 | 衍生金融资产 |  |
| `data.items.zc.zc.buysellbackfasset` | String | 是 | 买入返售金融资产 |  |
| `data.items.zc.zc.interestrec` | String | 是 | 应收利息 |  |
| `data.items.zc.zc.premiumrec` | String | 是 | 应收保费 |  |
| `data.items.zc.zc.rirec` | String | 是 | 应收分保账款 |  |
| `data.items.zc.zc.ricontactreserverec` | String | 是 | 应收分保合同准备金 |  |
| `data.items.zc.zc.unduerireserverec` | String | 是 | 应收分保未到期责任准备金 |  |
| `data.items.zc.zc.claimrireserverec` | String | 是 | 应收分保未决赔偿准备金 |  |
| `data.items.zc.zc.liferireserverec` | String | 是 | 应收分保寿险责任准备金 |  |
| `data.items.zc.zc.lthealthrireserverec` | String | 是 | 应收分保长期健康险责任准备金 |  |
| `data.items.zc.zc.insuredpledgeloan` | String | 是 | 保户质押贷款 |  |
| `data.items.zc.zc.loanadvances` | String | 是 | 发放贷款及垫款 |  |
| `data.items.zc.zc.gdepositpay` | String | 是 | 存出保证金 |  |
| `data.items.zc.zc.creditorplaninv` | String | 是 | 债权计划投资 |  |
| `data.items.zc.zc.otherrec` | String | 是 | 其他应收款 |  |
| `data.items.zc.zc.tdeposit` | String | 是 | 定期存款 |  |
| `data.items.zc.zc.saleablefasset` | String | 是 | 可供出售金融资产 |  |
| `data.items.zc.zc.heldmaturityinv` | String | 是 | 持有至到期投资 |  |
| `data.items.zc.zc.investrec` | String | 是 | 应收款项类投资 |  |
| `data.items.zc.zc.accountrec` | String | 是 | 应收账款 |  |
| `data.items.zc.zc.ltequityinv` | String | 是 | 长期股权投资 |  |
| `data.items.zc.zc.capitalgdepositpay` | String | 是 | 存出资本保证金 |  |
| `data.items.zc.zc.estateinvest` | String | 是 | 投资性房地产 |  |
| `data.items.zc.zc.fixedasset` | String | 是 | 固定资产 |  |
| `data.items.zc.zc.constructionprogress` | String | 是 | 在建工程 |  |
| `data.items.zc.zc.intangibleasset` | String | 是 | 无形资产 |  |
| `data.items.zc.zc.goodwill` | String | 是 | 商誉 |  |
| `data.items.zc.zc.deferincometaxasset` | String | 是 | 递延所得税资产 |  |
| `data.items.zc.zc.otherasset` | String | 是 | 其他资产 |  |
| `data.items.zc.zc.independentasset` | String | 是 | 独立账户资产 |  |
| `data.items.zc.zc.assetother` | String | 是 | 资产其他项目 |  |
| `data.items.zc.zc.assetbalance` | String | 是 | 资产平衡项目 |  |
| `data.items.zc.zc.sumasset` | String | 是 | 资产总计 |  |
| `data.items.zc.zc.trade_finasset_notfvtpl` | String | 是 | 交易性金融资产 |  |
| `data.items.zc.zc.finance_rece` | String | 是 | 应收款项融资 |  |
| `data.items.zc.zc.heldsaleass` | String | 是 | 持有待售资产 |  |
| `data.items.zc.zc.useright_asset` | String | 是 | 使用权资产 |  |
| `data.items.fz` | Object | 是 | 负债 |  |
| `data.items.fz.fz.stborrow` | String | 是 | 短期借款 |  |
| `data.items.fz.fz.fideposit` | String | 是 | 同业及其他金融机构存放款项 |  |
| `data.items.fz.fz.gdepositrec` | String | 是 | 存入保证金 |  |
| `data.items.fz.fz.borrowfund` | String | 是 | 拆入资金 |  |
| `data.items.fz.fz.fvaluefliab` | String | 是 | 以公允价值计量且其变动计入当期损益的金融负债 |  |
| `data.items.fz.fz.tradefliab` | String | 是 | 其中:交易性金融负债 |  |
| `data.items.fz.fz.definefvaluefliab` | String | 是 | 指定以公允价值计量且其变动计入当期损益的金融负债 |  |
| `data.items.fz.fz.derivefliab` | String | 是 | 衍生金融负债 |  |
| `data.items.fz.fz.sellbuybackfasset` | String | 是 | 卖出回购金融资产款 |  |
| `data.items.fz.fz.acceptdeposit` | String | 是 | 吸收存款 |  |
| `data.items.fz.fz.agenttradesecurity` | String | 是 | 代理买卖证券款 |  |
| `data.items.fz.fz.accountpay` | String | 是 | 应付账款 |  |
| `data.items.fz.fz.billpay` | String | 是 | 应付票据 |  |
| `data.items.fz.fz.advancerec` | String | 是 | 预收账款 |  |
| `data.items.fz.fz.premiumadvance` | String | 是 | 预收保费 |  |
| `data.items.fz.fz.commpay` | String | 是 | 应付手续费及佣金 |  |
| `data.items.fz.fz.ripay` | String | 是 | 应付分保账款 |  |
| `data.items.fz.fz.salarypay` | String | 是 | 应付职工薪酬 |  |
| `data.items.fz.fz.taxpay` | String | 是 | 应交税费 |  |
| `data.items.fz.fz.interestpay` | String | 是 | 应付利息 |  |
| `data.items.fz.fz.dividendpay` | String | 是 | 应付股利 |  |
| `data.items.fz.fz.anticipateliab` | String | 是 | 预计负债 |  |
| `data.items.fz.fz.claimpay` | String | 是 | 应付赔付款 |  |
| `data.items.fz.fz.policydivipay` | String | 是 | 应付保单红利 |  |
| `data.items.fz.fz.otherpay` | String | 是 | 其他应付款 |  |
| `data.items.fz.fz.insureddepositinv` | String | 是 | 保户储金及投资款 |  |
| `data.items.fz.fz.contactreserve` | String | 是 | 保险合同准备金 |  |
| `data.items.fz.fz.unduereserve` | String | 是 | 未到期责任准备金 |  |
| `data.items.fz.fz.claimreserve` | String | 是 | 未决赔款准备金 |  |
| `data.items.fz.fz.lifereserve` | String | 是 | 寿险责任准备金 |  |
| `data.items.fz.fz.lthealthreserve` | String | 是 | 长期健康险责任准备金 |  |
| `data.items.fz.fz.ltborrow` | String | 是 | 长期借款 |  |
| `data.items.fz.fz.bondpay` | String | 是 | 应付债券 |  |
| `data.items.fz.fz.juniorbondpay` | String | 是 | 应付次级债 |  |
| `data.items.fz.fz.deferincometaxliab` | String | 是 | 递延所得税负债 |  |
| `data.items.fz.fz.otherliab` | String | 是 | 其他负债 |  |
| `data.items.fz.fz.independentliab` | String | 是 | 独立账户负债 |  |
| `data.items.fz.fz.liabother` | String | 是 | 负债其他项目 |  |
| `data.items.fz.fz.liabbalance` | String | 是 | 负债平衡项目 |  |
| `data.items.fz.fz.sumliab` | String | 是 | 负债合计 |  |
| `data.items.fz.fz.trade_finliab_notfvtpl` | String | 是 | 交易性金融负债 |  |
| `data.items.fz.fz.heldsaleliab` | String | 是 | 持有待售负债 |  |
| `data.items.fz.fz.lease_liab` | String | 是 | 租赁负债 |  |
| `data.items.syzqy` | Object | 是 | 所有者权益 |  |
| `data.items.syzqy.syzqy.retainedearning` | String | 是 | 未分配利润 |  |
| `data.items.syzqy.syzqy.generalriskprepare` | String | 是 | 一般风险准备 |  |
| `data.items.syzqy.syzqy.sharecapital` | String | 是 | 股本 |  |
| `data.items.syzqy.syzqy.diffconversionfc` | String | 是 | 外币报表折算差额 |  |
| `data.items.syzqy.syzqy.surplusreserve` | String | 是 | 盈余公积 |  |
| `data.items.syzqy.syzqy.capitalreserve` | String | 是 | 资本公积 |  |
| `data.items.fzhgdqyzj` | Object | 是 | 负债和股东权益总计 |  |
| `data.items.fzhgdqyzj.fzhgdqyzj.liabshequityother` | String | 是 | 负债和股东权益其他项目 |  |
| `data.items.fzhgdqyzj.fzhgdqyzj.sumliabshequity` | String | 是 | 负债和股东权益总计 |  |
| `data.items.fzhgdqyzj.fzhgdqyzj.liabshequitybalance` | String | 是 | 负债和股东权益平衡项目 |  |
| `data.items.gdqyhj` | Object | 是 | 股东权益合计 |  |
| `data.items.gdqyhj.gdqyhj.sumshequity` | String | 是 | 股东权益合计 |  |
| `data.items.gdqyhj.gdqyhj.shequityother` | String | 是 | 股东权益其他项目 |  |
| `data.items.gdqyhj.gdqyhj.shequitybalance` | String | 是 | 股东权益平衡项目 |  |
| `data.items.gdqyhj.gdqyhj.minorityequity` | String | 是 | 少数股东权益 |  |
| `data.items.gsymgsgdqyzj` | Object | 是 | 归属于母公司股东权益总计 |  |
| `data.items.gsymgsgdqyzj.gsymgsgdqyzj.parentequityother` | String | 是 | 归属于母公司股东权益其他项目 |  |
| `data.items.gsymgsgdqyzj.gsymgsgdqyzj.parentequitybalance` | String | 是 | 归属于母公司股东权益平衡项目 |  |
| `data.items.gsymgsgdqyzj.gsymgsgdqyzj.sumparentequity` | String | 是 | 归属于母公司股东权益总计 |  |
| `data.items.reportdate` | String | 是 | 报表日期，报表日期：指上报财务报表的具体日期，fntype = "127000000606281107"为证券类型返回的字段 |  |
| `data.items.format_reportdate` | String | 是 | 报表时间类型，年份+季度/半年度/年度的报表 |  |
| `data.items.fntype` | String | 是 | 127000000606281107 |  |
| `data.items.syzqy` | Object | 是 | 所有者权益 |  |
| `data.items.syzqy.syzqy.diffconversionfc` | String | 是 | 外币报表折算差额 |  |
| `data.items.syzqy.syzqy.retainedearning` | String | 是 | 未分配利润 |  |
| `data.items.syzqy.syzqy.traderiskprepare` | String | 是 | 交易风险准备 |  |
| `data.items.syzqy.syzqy.capitalreserve` | String | 是 | 资本公积 |  |
| `data.items.syzqy.syzqy.sharecapital` | String | 是 | 股本 |  |
| `data.items.syzqy.syzqy.inventoryshare` | String | 是 | 库存股 |  |
| `data.items.syzqy.syzqy.surplusreserve` | String | 是 | 盈余公积 |  |
| `data.items.syzqy.syzqy.generalriskprepare` | String | 是 | 一般风险准备 |  |
| `data.items.zc` | Object | 是 | 资产 |  |
| `data.items.zc.zc.monetaryfund` | String | 是 | 货币资金 |  |
| `data.items.zc.zc.clientfund` | String | 是 | 客户资金存款 |  |
| `data.items.zc.zc.clientcreditfund` | String | 是 | 客户信用资金存款 |  |
| `data.items.zc.zc.settlementprovision` | String | 是 | 结算备付金 |  |
| `data.items.zc.zc.clientprovision` | String | 是 | 客户备付金 |  |
| `data.items.zc.zc.creditprovision` | String | 是 | 信用备付金 |  |
| `data.items.zc.zc.lendfund` | String | 是 | 拆出资金 |  |
| `data.items.zc.zc.marginoutfund` | String | 是 | 融出资金 |  |
| `data.items.zc.zc.marginoutsecurity` | String | 是 | 融出证券 |  |
| `data.items.zc.zc.tradefasset` | String | 是 | 其中:交易性金融资产 |  |
| `data.items.zc.zc.derivefasset` | String | 是 | 衍生金融资产 |  |
| `data.items.zc.zc.buysellbackfasset` | String | 是 | 买入返售金融资产 |  |
| `data.items.zc.zc.interestrec` | String | 是 | 应收利息 |  |
| `data.items.zc.zc.dividendrec` | String | 是 | 应收股利 |  |
| `data.items.zc.zc.gdepositpay` | String | 是 | 存出保证金 |  |
| `data.items.zc.zc.saleablefasset` | String | 是 | 可供出售金融资产 |  |
| `data.items.zc.zc.heldmaturityinv` | String | 是 | 持有至到期投资 |  |
| `data.items.zc.zc.ltequityinv` | String | 是 | 长期股权投资 |  |
| `data.items.zc.zc.estateinvest` | String | 是 | 投资性房地产 |  |
| `data.items.zc.zc.fixedasset` | String | 是 | 固定资产 |  |
| `data.items.zc.zc.constructionprogress` | String | 是 | 在建工程 |  |
| `data.items.zc.zc.intangibleasset` | String | 是 | 无形资产 |  |
| `data.items.zc.zc.seatfee` | String | 是 | 交易席位费 |  |
| `data.items.zc.zc.goodwill` | String | 是 | 商誉 |  |
| `data.items.zc.zc.deferincometaxasset` | String | 是 | 递延所得税资产 |  |
| `data.items.zc.zc.otherasset` | String | 是 | 其他资产 |  |
| `data.items.zc.zc.assetother` | String | 是 | 资产其他项目 |  |
| `data.items.zc.zc.assetbalance` | String | 是 | 资产平衡项目 |  |
| `data.items.zc.zc.sumasset` | String | 是 | 资产总计 |  |
| `data.items.zc.zc.fvaluefasset` | String | 是 | 以公允价值计量且其变动计入当期损益的金融资产 |  |
| `data.items.zc.zc.definefvaluefasset` | String | 是 | 指定以公允价值计量且其变动计入当期损益的金融资产 |  |
| `data.items.zc.zc.receivables` | String | 是 | 应收款项 |  |
| `data.items.zc.zc.trade_finasset_notfvtpl` | String | 是 | 交易性金融资产 |  |
| `data.items.zc.zc.finance_rece` | String | 是 | 应收款项融资 |  |
| `data.items.zc.zc.heldsaleass` | String | 是 | 持有待售资产 |  |
| `data.items.zc.zc.useright_asset` | String | 是 | 使用权资产 |  |
| `data.items.gdqyhj` | Object | 是 | 股东权益合计 |  |
| `data.items.gdqyhj.gdqyhj.sumshequity` | String | 是 | 股东权益合计 |  |
| `data.items.gdqyhj.gdqyhj.shequityother` | String | 是 | 股东权益其他项目 |  |
| `data.items.gdqyhj.gdqyhj.shequitybalance` | String | 是 | 股东权益平衡项目 |  |
| `data.items.gdqyhj.gdqyhj.minorityequity` | String | 是 | 少数股东权益 |  |
| `data.items.fz` | Object | 是 | 负债 |  |
| `data.items.fz.fz.taxpay` | String | 是 | 应交税费 |  |
| `data.items.fz.fz.sumliab` | String | 是 | 负债合计 |  |
| `data.items.fz.fz.bondpay` | String | 是 | 应付债券 |  |
| `data.items.fz.fz.liabbalance` | String | 是 | 负债平衡项目 |  |
| `data.items.fz.fz.borrowfund` | String | 是 | 拆入资金 |  |
| `data.items.fz.fz.cagenttradesecurity` | String | 是 | 客户信用交易代理买卖证券款 |  |
| `data.items.fz.fz.pledgeborrow` | String | 是 | 质押借款 |  |
| `data.items.fz.fz.dividendpay` | String | 是 | 应付股利 |  |
| `data.items.fz.fz.anticipateliab` | String | 是 | 预计负债 |  |
| `data.items.fz.fz.agenttradesecurity` | String | 是 | 代理买卖证券款 |  |
| `data.items.fz.fz.stborrow` | String | 是 | 短期借款 |  |
| `data.items.fz.fz.sellbuybackfasset` | String | 是 | 卖出回购金融资产款 |  |
| `data.items.fz.fz.accountpay` | String | 是 | 应付账款 |  |
| `data.items.fz.fz.agentuwsecurity` | String | 是 | 代理承销证券款 |  |
| `data.items.fz.fz.salarypay` | String | 是 | 应付职工薪酬 |  |
| `data.items.fz.fz.ltborrow` | String | 是 | 长期借款 |  |
| `data.items.fz.fz.shortfinancing` | String | 是 | 应付短期融资款 |  |
| `data.items.fz.fz.definefvaluefliab` | String | 是 | 指定以公允价值计量且其变动计入当期损益的金融负债 |  |
| `data.items.fz.fz.fvaluefliab` | String | 是 | 以公允价值计量且其变动计入当期损益的金融负债 |  |
| `data.items.fz.fz.interestpay` | String | 是 | 应付利息 |  |
| `data.items.fz.fz.tradefliab` | String | 是 | 其中:交易性金融负债 |  |
| `data.items.fz.fz.otherliab` | String | 是 | 其他负债 |  |
| `data.items.fz.fz.liabother` | String | 是 | 负债其他项目 |  |
| `data.items.fz.fz.deferincometaxliab` | String | 是 | 递延所得税负债 |  |
| `data.items.fz.fz.derivefliab` | String | 是 | 衍生金融负债 |  |
| `data.items.fz.fz.trade_finliab_notfvtpl` | String | 是 | 交易性金融负债 |  |
| `data.items.fz.fz.heldsaleliab` | String | 是 | 持有待售负债 |  |
| `data.items.fz.fz.lease_liab` | String | 是 | 租赁负债 |  |
| `data.items.fz.fz.independentliab` | String | 是 | 独立账户负债 |  |
| `data.items.fz.fz.policydivipay` | String | 是 | 应付保单红利 |  |
| `data.items.fz.fz.lthealthreserve` | String | 是 | 长期健康险责任准备金 |  |
| `data.items.fz.fz.unduereserve` | String | 是 | 未到期责任准备金 |  |
| `data.items.fz.fz.lifereserve` | String | 是 | 寿险责任准备金 |  |
| `data.items.fz.fz.advancerec` | String | 是 | 预收账款 |  |
| `data.items.fz.fz.insureddepositinv` | String | 是 | 保户储金及投资款 |  |
| `data.items.fz.fz.otherpay` | String | 是 | 其他应付款 |  |
| `data.items.fz.fz.gdepositrec` | String | 是 | 存入保证金 |  |
| `data.items.fz.fz.premiumadvance` | String | 是 | 预收保费 |  |
| `data.items.fz.fz.claimreserve` | String | 是 | 未决赔款准备金 |  |
| `data.items.fz.fz.contactreserve` | String | 是 | 保险合同准备金 |  |
| `data.items.fz.fz.commpay` | String | 是 | 应付手续费及佣金 |  |
| `data.items.fz.fz.ripay` | String | 是 | 应付分保账款 |  |
| `data.items.fz.fz.billpay` | String | 是 | 应付票据 |  |
| `data.items.fz.fz.claimpay` | String | 是 | 应付赔付款 |  |
| `data.items.gsymgsgdqyhj` | Object | 是 | 归属于母公司股东权益合计 |  |
| `data.items.gsymgsgdqyhj.gsymgsgdqyhj.parentequityother` | String | 是 | 归属于母公司股东权益其他项目 |  |
| `data.items.gsymgsgdqyhj.gsymgsgdqyhj.parentequitybalance` | String | 是 | 归属于母公司股东权益平衡项目 |  |
| `data.items.gsymgsgdqyhj.gsymgsgdqyhj.sumparentequity` | String | 是 | 归属于母公司股东权益合计 |  |
| `data.items.fzhgdqyhj` | Object | 是 | 负债和股东权益总计 |  |
| `data.items.fzhgdqyhj.fzhgdqyhj.liabshequityother` | String | 是 | 负债和股东权益其他项目 |  |
| `data.items.fzhgdqyhj.fzhgdqyhj.sumliabshequity` | String | 是 | 负债和股东权益总计 |  |
| `data.items.fzhgdqyhj.fzhgdqyhj.liabshequitybalance` | String | 是 | 负债和股东权益平衡项目 |  |
| `data.items.reportdate` | String | 是 | 报表日期，报表日期：指上报财务报表的具体日期，fntype = "127000000606281483"通用类型返回的字段 |  |
| `data.items.format_reportdate` | String | 是 | 报表时间类型，年份+季度/半年度/年度的报表 |  |
| `data.items.fntype` | String | 是 | 127000000606281483 |  |
| `data.items.fldfzhj` | Object | 是 | 非流动负债合计 |  |
| `data.items.fldfzhj.fldfzhj.liabbalance` | String | 是 | 负债平衡项目 |  |
| `data.items.fldfzhj.fldfzhj.liabother` | String | 是 | 负债其他项目 |  |
| `data.items.fldfzhj.fldfzhj.sumliab` | String | 是 | 负债合计 |  |
| `data.items.gdqyhj` | Object | 是 | 股东权益合计 |  |
| `data.items.gdqyhj.gdqyhj.sumshequity` | String | 是 | 股东权益合计 |  |
| `data.items.gdqyhj.gdqyhj.shequityother` | String | 是 | 股东权益其他项目 |  |
| `data.items.gdqyhj.gdqyhj.shequitybalance` | String | 是 | 股东权益平衡项目 |  |
| `data.items.gdqyhj.gdqyhj.minorityequity` | String | 是 | 少数股东权益 |  |
| `data.items.gsymgsgdqyhj` | Object | 是 | 归属于母公司股东权益合计 |  |
| `data.items.gsymgsgdqyhj.gsymgsgdqyhj.parentequityother` | String | 是 | 归属于母公司股东权益其他项目 |  |
| `data.items.gsymgsgdqyhj.gsymgsgdqyhj.parentequitybalance` | String | 是 | 归属于母公司股东权益平衡项目 |  |
| `data.items.gsymgsgdqyhj.gsymgsgdqyhj.sumparentequity` | String | 是 | 归属于母公司股东权益合计 |  |
| `data.items.ldzc` | Object | 是 | 流动资产 |  |
| `data.items.ldzc.ldzc.lendfund` | String | 是 | 拆出资金 |  |
| `data.items.ldzc.ldzc.billrec` | String | 是 | 应收票据 |  |
| `data.items.ldzc.ldzc.settlementprovision` | String | 是 | 结算备付金 |  |
| `data.items.ldzc.ldzc.rirec` | String | 是 | 应收分保账款 |  |
| `data.items.ldzc.ldzc.nonlassetoneyear` | String | 是 | 一年内到期的非流动资产 |  |
| `data.items.ldzc.ldzc.subsidyrec` | String | 是 | 应收补贴款 |  |
| `data.items.ldzc.ldzc.advancepay` | String | 是 | 预付款项 |  |
| `data.items.ldzc.ldzc.premiumrec` | String | 是 | 应收保费 |  |
| `data.items.ldzc.ldzc.dividendrec` | String | 是 | 应收股利 |  |
| `data.items.ldzc.ldzc.buysellbackfasset` | String | 是 | 买入返售金融资产 |  |
| `data.items.ldzc.ldzc.lassetbalance` | String | 是 | 流动资产平衡项目 |  |
| `data.items.ldzc.ldzc.lassetother` | String | 是 | 流动资产其他项目 |  |
| `data.items.ldzc.ldzc.ricontactreserverec` | String | 是 | 应收分保合同准备金 |  |
| `data.items.ldzc.ldzc.tradefasset` | String | 是 | 其中:交易性金融资产 |  |
| `data.items.ldzc.ldzc.accountrec` | String | 是 | 应收账款 |  |
| `data.items.ldzc.ldzc.exportrebaterec` | String | 是 | 应收出口退税 |  |
| `data.items.ldzc.ldzc.otherrec` | String | 是 | 其他应收款 |  |
| `data.items.ldzc.ldzc.sumlasset` | String | 是 | 流动资产合计 |  |
| `data.items.ldzc.ldzc.otherlasset` | String | 是 | 其他流动资产 |  |
| `data.items.ldzc.ldzc.inventory` | String | 是 | 存货 |  |
| `data.items.ldzc.ldzc.monetaryfund` | String | 是 | 货币资金 |  |
| `data.items.ldzc.ldzc.interestrec` | String | 是 | 应收利息 |  |
| `data.items.ldzc.ldzc.internalrec` | String | 是 | 内部应收款 |  |
| `data.items.ldzc.ldzc.trade_finasset_notfvtpl` | String | 是 | 交易性金融资产 |  |
| `data.items.ldzc.ldzc.derivefasset` | String | 是 | 衍生金融资产 |  |
| `data.items.ldzc.ldzc.finance_rece` | String | 是 | 应收款项融资 |  |
| `data.items.ldzc.ldzc.contractasset` | String | 是 | 合同资产 |  |
| `data.items.ldzc.ldzc.heldsaleass` | String | 是 | 持有待售资产 |  |
| `data.items.fldzc` | Object | 是 | 非流动资产 |  |
| `data.items.fldzc.fldzc.ltequityinv` | String | 是 | 长期股权投资 |  |
| `data.items.fldzc.fldzc.othernonlasset` | String | 是 | 其他非流动资产 |  |
| `data.items.fldzc.fldzc.oilgasasset` | String | 是 | 油气资产 |  |
| `data.items.fldzc.fldzc.constructionprogress` | String | 是 | 在建工程 |  |
| `data.items.fldzc.fldzc.productbiologyasset` | String | 是 | 生产性生物资产 |  |
| `data.items.fldzc.fldzc.constructionmaterial` | String | 是 | 工程物资 |  |
| `data.items.fldzc.fldzc.saleablefasset` | String | 是 | 可供出售金融资产 |  |
| `data.items.fldzc.fldzc.liquidatefixedasset` | String | 是 | 固定资产清理 |  |
| `data.items.fldzc.fldzc.ltdeferasset` | String | 是 | 长期待摊费用 |  |
| `data.items.fldzc.fldzc.assetbalance` | String | 是 | 资产平衡项目 |  |
| `data.items.fldzc.fldzc.estateinvest` | String | 是 | 投资性房地产 |  |
| `data.items.fldzc.fldzc.intangibleasset` | String | 是 | 无形资产 |  |
| `data.items.fldzc.fldzc.loanadvances` | String | 是 | 发放委托贷款及垫款 |  |
| `data.items.fldzc.fldzc.heldmaturityinv` | String | 是 | 持有至到期投资 |  |
| `data.items.fldzc.fldzc.nonlassetother` | String | 是 | 非流动资产其他项目 |  |
| `data.items.fldzc.fldzc.deferincometaxasset` | String | 是 | 递延所得税资产 |  |
| `data.items.fldzc.fldzc.sumnonlasset` | String | 是 | 非流动资产合计 |  |
| `data.items.fldzc.fldzc.fixedasset` | String | 是 | 固定资产 |  |
| `data.items.fldzc.fldzc.ltrec` | String | 是 | 长期应收款 |  |
| `data.items.fldzc.fldzc.goodwill` | String | 是 | 商誉 |  |
| `data.items.fldzc.fldzc.assetother` | String | 是 | 资产其他项目 |  |
| `data.items.fldzc.fldzc.nonlassetbalance` | String | 是 | 非流动资产平衡项目 |  |
| `data.items.fldzc.fldzc.developexp` | String | 是 | 开发支出 |  |
| `data.items.fldzc.fldzc.sumasset` | String | 是 | 资产总计 |  |
| `data.items.fldzc.fldzc.otherequityinv` | String | 是 | 其他权益工具投资 |  |
| `data.items.fldzc.fldzc.othernonfasset` | String | 是 | 其他非流动金融资产 |  |
| `data.items.fldzc.fldzc.useright_asset` | String | 是 | 使用权资产 |  |
| `data.items.fzhgdqyhj` | Object | 是 | 负债和股东权益合计 |  |
| `data.items.fzhgdqyhj.fzhgdqyhj.liabshequityother` | String | 是 | 负债和股东权益其他项目 |  |
| `data.items.fzhgdqyhj.fzhgdqyhj.sumliabshequity` | String | 是 | 负债和股东权益合计 |  |
| `data.items.fzhgdqyhj.fzhgdqyhj.liabshequitybalance` | String | 是 | 负债和股东权益平衡项目 |  |
| `data.items.fldfz` | Object | 是 | 非流动负债 |  |
| `data.items.fldfz.fldfz.specialpay` | String | 是 | 专项应付款 |  |
| `data.items.fldfz.fldfz.sumnonlliab` | String | 是 | 非流动负债合计 |  |
| `data.items.fldfz.fldfz.othernonlliab` | String | 是 | 其他非流动负债 |  |
| `data.items.fldfz.fldfz.bondpay` | String | 是 | 应付债券 |  |
| `data.items.fldfz.fldfz.ltborrow` | String | 是 | 长期借款 |  |
| `data.items.fldfz.fldfz.sustainbond` | String | 是 | 其中:永续债 |  |
| `data.items.fldfz.fldfz.preferstocbond` | String | 是 | 其中:优先股 |  |
| `data.items.fldfz.fldfz.nonlliabother` | String | 是 | 非流动负债其他项目 |  |
| `data.items.fldfz.fldfz.anticipateliab` | String | 是 | 预计负债 |  |
| `data.items.fldfz.fldfz.deferincometaxliab` | String | 是 | 递延所得税负债 |  |
| `data.items.fldfz.fldfz.deferincome` | String | 是 | 递延收益 |  |
| `data.items.fldfz.fldfz.nonlliabbalance` | String | 是 | 非流动负债平衡项目 |  |
| `data.items.fldfz.fldfz.ltaccountpay` | String | 是 | 长期应付款 |  |
| `data.items.ldfz` | Object | 是 | 流动负债 |  |
| `data.items.ldfz.ldfz.taxpay` | String | 是 | 应交税费 |  |
| `data.items.ldfz.ldfz.borrowfund` | String | 是 | 拆入资金 |  |
| `data.items.ldfz.ldfz.sumlliab` | String | 是 | 流动负债合计 |  |
| `data.items.ldfz.ldfz.lliabbalance` | String | 是 | 流动负债平衡项目 |  |
| `data.items.ldfz.ldfz.internalpay` | String | 是 | 内部应付款 |  |
| `data.items.ldfz.ldfz.lliabother` | String | 是 | 流动负债其他项目 |  |
| `data.items.ldfz.ldfz.dividendpay` | String | 是 | 应付股利 |  |
| `data.items.ldfz.ldfz.otherlliab` | String | 是 | 其他流动负债 |  |
| `data.items.ldfz.ldfz.advancereceive` | String | 是 | 预收款项 |  |
| `data.items.ldfz.ldfz.deposit` | String | 是 | 吸收存款及同业存放 |  |
| `data.items.ldfz.ldfz.nonlliaboneyear` | String | 是 | 一年内到期的非流动负债 |  |
| `data.items.ldfz.ldfz.agenttradesecurity` | String | 是 | 代理买卖证券款 |  |
| `data.items.ldfz.ldfz.stborrow` | String | 是 | 短期借款 |  |
| `data.items.ldfz.ldfz.sellbuybackfasset` | String | 是 | 卖出回购金融资产款 |  |
| `data.items.ldfz.ldfz.accountpay` | String | 是 | 应付账款 |  |
| `data.items.ldfz.ldfz.contactreserve` | String | 是 | 保险合同准备金 |  |
| `data.items.ldfz.ldfz.salarypay` | String | 是 | 应付职工薪酬 |  |
| `data.items.ldfz.ldfz.deferincomeoneyear` | String | 是 | 一年内的递延收益 |  |
| `data.items.ldfz.ldfz.stbondrec` | String | 是 | 应付短期债券 |  |
| `data.items.ldfz.ldfz.anticipatelliab` | String | 是 | 预计流动负债 |  |
| `data.items.ldfz.ldfz.billpay` | String | 是 | 应付票据 |  |
| `data.items.ldfz.ldfz.agentuwsecurity` | String | 是 | 代理承销证券款 |  |
| `data.items.ldfz.ldfz.ripay` | String | 是 | 应付分保账款 |  |
| `data.items.ldfz.ldfz.tradefliab` | String | 是 | 其中:交易性金融负债 |  |
| `data.items.ldfz.ldfz.otherpay` | String | 是 | 其他应付款 |  |
| `data.items.ldfz.ldfz.interestpay` | String | 是 | 应付利息 |  |
| `data.items.ldfz.ldfz.borrowfromcbank` | String | 是 | 向中央银行借款 |  |
| `data.items.ldfz.ldfz.commpay` | String | 是 | 应付手续费及佣金 |  |
| `data.items.ldfz.ldfz.trade_finliab_notfvtpl` | String | 是 | 交易性金融负债 |  |
| `data.items.ldfz.ldfz.derivefliab` | String | 是 | 衍生金融负债 |  |
| `data.items.ldfz.ldfz.contractliab` | String | 是 | 合同负债 |  |
| `data.items.ldfz.ldfz.heldsaleliab` | String | 是 | 持有待售负债 |  |
| `data.items.ldfz.ldfz.ltsalarypay` | String | 是 | 长期应付职工薪酬 |  |
| `data.items.ldfz.ldfz.lease_liab` | String | 是 | 租赁负债 |  |
| `data.items.syzqy` | Object | 是 | 所有者权益 |  |
| `data.items.syzqy.syzqy.plancashdivi` | String | 是 | 拟分配现金股利 |  |
| `data.items.syzqy.syzqy.generalriskprepare` | String | 是 | 一般风险准备 |  |
| `data.items.syzqy.syzqy.sharecapital` | String | 是 | 实收资本（或股本） |  |
| `data.items.syzqy.syzqy.unconfirminvloss` | String | 是 | 未确定的投资损失 |  |
| `data.items.syzqy.syzqy.surplusreserve` | String | 是 | 盈余公积 |  |
| `data.items.syzqy.syzqy.capitalreserve` | String | 是 | 资本公积 |  |
| `data.items.syzqy.syzqy.diffconversionfc` | String | 是 | 外币报表折算差额 |  |
| `data.items.syzqy.syzqy.specialreserve` | String | 是 | 专项储备 |  |
| `data.items.syzqy.syzqy.retainedearning` | String | 是 | 未分配利润 |  |
| `data.items.syzqy.syzqy.inventoryshare` | String | 是 | 库存股fntype = "127000000606281483" |  |

### 43.2 新三板

- Hub：`POST /api/v1/data/enterprise/43.2/query`；上游方法 GET；可调用
- 说明：新三板企业信息，包括企业相关信息、股东信息、股票流通等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.turnover` | String | 是 | 成交金额(单位：亿元) |  |
| `data.volumn` | String | 是 | 成交量(单位：万股) |  |
| `data.zsqs` | String | 是 | 做市券商 |  |
| `data.pyjc` | String | 是 | 拼音简称 |  |
| `data.dm` | String | 是 | 董秘 |  |
| `data.stocks` | Array | 是 | 股东信息列表 |  |
| `data.stocks[].jzrq` | String | 是 | 数据截止日期 |  |
| `data.stocks[].sharehdcount` | String | 是 | 股东户数 |  |
| `data.stocks[].name` | String | 是 | 股东名称 |  |
| `data.stocks[].sharehold` | String | 是 | 持股数量（万股） |  |
| `data.stocks[].change` | String | 是 | 增减情况（万股） |  |
| `data.stocks[].shareType` | String | 是 | 股份类型 |  |
| `data.stocks[].eid` | String | 是 | 企业ID |  |
| `data.stocks[].category` | String | 是 | 股票持有者种类 |  |
| `data.url` | String | 是 | 企业网址 | 🔗 |
| `data.clrq` | String | 是 | 成立日期 |  |
| `data.zjl` | String | 是 | 总经理 |  |
| `data.gsyg` | String | 是 | 企业沿革 |  |
| `data.ltgb` | String | 是 | 流通股本(单位：万股) |  |
| `data.employees` | Array | 是 | 高管人员信息列表 |  |
| `data.employees[].name` | String | 是 | 高管人员姓名 |  |
| `data.employees[].position` | String | 是 | 职务 |  |
| `data.employees[].education` | String | 是 | 学历 |  |
| `data.employees[].resume` | String | 是 | 简历 |  |
| `data.employees[].birthday` | String | 是 | 出生年月 |  |
| `data.employees[].riqi` | String | 是 | 任职日期 |  |
| `data.employees[].sharehold` | String | 是 | 持股数量 |  |
| `data.employees[].jzrq` | String | 是 | 数据截止日期 |  |
| `data.ssdq` | String | 是 | 所属地区 |  |
| `data.zbqs` | String | 是 | 主办券商 |  |
| `data.chg` | String | 是 | 涨跌(单位：元) |  |
| `data.zsz` | String | 是 | 总市值(单位：亿元) |  |
| `data.industry` | String | 是 | 所属行业(证监会行业标准) |  |
| `data.pb` | String | 是 | 市净率，保留两位小数 |  |
| `data.pchg` | String | 是 | 涨跌幅(单位：%) |  |
| `data.sname` | String | 是 | 股票简称 |  |
| `data.bgdz` | String | 是 | 办公地址 |  |
| `data.dsz` | String | 是 | 董事长 |  |
| `data.dmdh` | String | 是 | 董秘电话 |  |
| `data.pe` | String | 是 | 市盈率，保留两位小数 |  |
| `data.gprq` | String | 是 | 挂牌日期 |  |
| `data.ltsz` | String | 是 | 流通市值(单位：亿元) |  |
| `data.zgb` | String | 是 | 总股本(单位：万股) |  |
| `data.zcdz` | String | 是 | 注册地址 |  |
| `data.companyname` | String | 是 | 企业全称 |  |
| `data.jyfw` | String | 是 | 经营范围 |  |
| `data.eid` | String | 是 | 企业ID |  |
| `data.symbol` | String | 是 | 股票代码 |  |
| `data.ygsl` | String | 是 | 企业员工总数 |  |
| `data.jyfs` | String | 是 | 交易方式，1：做市，2：协议，3：两网退市 |  |
| `data.tclose` | String | 是 | 最新价(单位：元) |  |
| `data.ssyq` | String | 是 | 所属科技园区 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 58.3 债券基础信息

- Hub：`POST /api/v1/data/enterprise/58.3/query`；上游方法 GET；可调用
- 说明：债券信息，包括债券基础信息、发行信息、信用等级等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 企业债券列表 |  |
| `data.items[].trademarketcode` | String | 是 | 交易场所 |  |
| `data.items[].mrtydate` | String | 是 | 到期日期 |  |
| `data.items[].tcodeqxb` | String | 是 | 债券代码 |  |
| `data.items[].firstvaluedate` | String | 是 | 起息日期 |  |
| `data.items[].issuevol` | String | 是 | 发行规模 |  |
| `data.items[].parvalue` | String | 是 | 债券面值 |  |
| `data.items[].coupontype` | String | 是 | 计息方式 |  |
| `data.items[].issuedate` | String | 是 | 发行日期 |  |
| `data.items[].credittypein` | String | 是 | 内部信用增级方式 |  |
| `data.items[].listvolsh` | String | 是 | 沪市上市规模 |  |
| `data.items[].paytype` | String | 是 | 付息方式 |  |
| `data.items[].ratedes` | String | 是 | 利率说明 |  |
| `data.items[].issueprice` | String | 是 | 发行价格 |  |
| `data.items[].listdate` | String | 是 | 上市日期 |  |
| `data.items[].couponrate` | String | 是 | 票面利率(%) |  |
| `data.items[].credittypeout` | String | 是 | 外部信用增级方式 |  |
| `data.items[].securitysname` | String | 是 | 债券简称 |  |
| `data.items[].creditrating` | String | 是 | 信用等级 |  |
| `data.items[].currency` | String | 是 | 币种 |  |
| `data.items[].payperyear` | String | 是 | 年付息次数 |  |
| `data.items[].listvolsz` | String | 是 | 深市上市规模 |  |
| `data.items[].paymentdate` | String | 是 | 兑付日期(法定) |  |
| `data.items[].securityname` | String | 是 | 债券全称 |  |
| `data.items[].payday` | String | 是 | 每年付息日 |  |
| `data.items[].issuetype` | String | 是 | 募集方式，1：公募债券，2：私募债券 |  |
| `data.items[].securitytype` | String | 是 | 债券类型 |  |
| `data.items[].lastvaluedate` | String | 是 | 止息日期 |  |
| `data.items[].bondperiod` | String | 是 | 债券期限(年) |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 72.1 私募管理人列表

- Hub：`POST /api/v1/data/enterprise/72.1/query`；上游方法 GET；可调用
- 说明：私募管理人列表，包括私募基金管理人名称、法定代表人/执行事务合伙人、登记编号、注册地等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `skip(可选)` | Number | 是 | 跳过条目数（默认为0） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 私募管理人列表 |  |
| `data.items[].oper_id` | String | 是 | 执行事务合伙人id |  |
| `data.items[].id` | String | 是 | 管理人id |  |
| `data.items[].name` | String | 是 | 私募基金管理人名称 |  |
| `data.items[].fund_no` | String | 是 | 登记编号 |  |
| `data.items[].start_date` | String | 是 | 成立日期 |  |
| `data.items[].oper_name` | String | 是 | 法定代表人/执行事务合伙人 |  |
| `data.items[].city_code` | String | 是 | 注册区域码 |  |
| `data.items[].fund_date` | String | 是 | 登记日期 |  |
| `data.items[].reg_city` | String | 是 | 注册地 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 72.2 私募管理人信息

- Hub：`POST /api/v1/data/enterprise/72.2/query`；上游方法 GET；可调用
- 说明：私募管理人信息，包括私募基金管理人名称、法定代表人/执行事务合伙人、登记编号、组织机构代码、注册地址、注册资金、实缴资金等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 私募基金管理人名称 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.law_firm_eid` | String | 是 | 律师事务所id |  |
| `data.employee_num` | Number | 是 | 全职员工人数 |  |
| `data.member_type` | String | 是 | 会员类型 |  |
| `data.address` | String | 是 | 注册地址 |  |
| `data.org_no` | String | 是 | 组织机构代码 |  |
| `data.reg_city` | String | 是 | 注册地 |  |
| `data.real_capi_percent` | String | 是 | 实缴比例 |  |
| `data.lawyer` | String | 是 | 律师姓名 |  |
| `data.name` | String | 是 | 私募基金管理人名称 |  |
| `data.reminder` | String | 是 | 特别提示信息 |  |
| `data.fund_no` | String | 是 | 登记编号 |  |
| `data.law_firm` | String | 是 | 律师事务所名称 |  |
| `data.member_time` | String | 是 | 入会时间 |  |
| `data.type` | String | 是 | 机构类型 |  |
| `data.law_status` | String | 是 | 法律意见书状态 |  |
| `data.is_member` | String | 是 | 是否会员 |  |
| `data.start_date` | String | 是 | 成立日期 |  |
| `data.business_type` | String | 是 | 业务类型 |  |
| `data.reg_capi` | String | 是 | 注册资本(万人民币) |  |
| `data.en_name` | String | 是 | 基金管理人英文名 |  |
| `data.fund_date` | String | 是 | 登记日期 |  |
| `data.update_time` | String | 是 | 机构更新时间 |  |
| `data.websites` | String | 是 | 机构网址 | 🔗 |
| `data.controller` | String | 是 | 控制人名称 |  |
| `data.member_deputy` | String | 是 | 会员代表 |  |
| `data.ent_type` | String | 是 | 企业性质 |  |
| `data.dishonest` | String | 是 | 机构诚信信息 |  |
| `data.qualified_num` | Number | 是 | 取得基金从业人数 |  |
| `data.city_code` | String | 是 | 注册区域码 |  |
| `data.office_address` | String | 是 | 办公地址 |  |
| `data.oper_name` | String | 是 | 法定代表人/执行事务合伙人 |  |
| `data.real_capi` | String | 是 | 实缴资本(万人民币) |  |
| `data.is_qualified` | String | 是 | 是否为符合提供投资建议条件的第三方机构 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 72.3 私募管理人高管

- Hub：`POST /api/v1/data/enterprise/72.3/query`；上游方法 GET；可调用
- 说明：私募管理人高管，包括高管姓名、职务、是否有基金从业资格、资格获取方式、工作履历等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 私募管理人高管信息列表 |  |
| `data.items[].title` | String | 是 | 职务 |  |
| `data.items[].is_qualified` | Number | 是 | 是否有基金从业资格 |  |
| `data.items[].record` | String | 是 | 工作履历 |  |
| `data.items[].name` | String | 是 | 高管姓名 |  |
| `data.items[].qualified_type` | String | 是 | 资格获取方式 |  |
| `data.items[].fund_no` | String | 是 | 登记编号 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 72.4 私募管理人关联方

- Hub：`POST /api/v1/data/enterprise/72.4/query`；上游方法 GET；可调用
- 说明：私募管理人关联方，包括登记编号、机构类型、关联方名称、关联方登记编号、组织机构代码等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 私募管理人关联方信息列表 |  |
| `data.items[].org_no` | String | 是 | 组织机构代码 |  |
| `data.items[].type` | String | 是 | 机构类型 |  |
| `data.items[].name` | String | 是 | 关联方名称 |  |
| `data.items[].connected_fund_no` | String | 是 | 关联方登记编号 |  |
| `data.items[].fund_no` | String | 是 | 登记编号 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 72.5 私募管理产品查询

- Hub：`POST /api/v1/data/enterprise/72.5/query`；上游方法 GET；可调用
- 说明：私募管理产品，包括基金编号、基金名称、基金类型、币种、基金管理人名称、管理类型、托管人名称、运作状态等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 私募基金管理人名称 |
| `skip` | Number | 否 | 跳过条目数（默认为0） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 私募管理人产品信息列表 |  |
| `data.items[].manage_type` | String | 是 | 管理类型 |  |
| `data.items[].status` | String | 是 | 运作状态 |  |
| `data.items[].should_report_monthly` | Number | 是 | 当月月报应披露 |  |
| `data.items[].unreport_monthly` | Number | 是 | 当月月报未披露 |  |
| `data.items[].unreport_annually` | Number | 是 | 年报未披露 |  |
| `data.items[].report_annually` | Number | 是 | 年报按时披露 |  |
| `data.items[].unreport_quarterly` | Number | 是 | 季报未披露 |  |
| `data.items[].should_report_annually` | Number | 是 | 年报应披露 |  |
| `data.items[].unreport_semiannually` | Number | 是 | 半年报未披露 |  |
| `data.items[].update_time` | String | 是 | 基金更新时间 |  |
| `data.items[].start_date` | String | 是 | 成立日期 |  |
| `data.items[].should_report_semiannually` | Number | 是 | 半年报应披露 |  |
| `data.items[].trust_name` | String | 是 | 托管人名称 |  |
| `data.items[].reg_step` | Number | 是 | 基金备案阶段 |  |
| `data.items[].name` | String | 是 | 基金名称 |  |
| `data.items[].reminder` | String | 是 | 基金业协会提示 |  |
| `data.items[].fund_no` | String | 是 | 基金编号 |  |
| `data.items[].reg_date` | String | 是 | 备案日期 |  |
| `data.items[].should_report_quarterly` | Number | 是 | 季报应披露 |  |
| `data.items[].report_quarterly` | Number | 是 | 季报按时披露 |  |
| `data.items[].report_monthly` | Number | 是 | 当月月报按时披露 |  |
| `data.items[].report_semiannually` | Number | 是 | 半年报按时披露 |  |
| `data.items[].currency` | String | 是 | 币种 |  |
| `data.items[].manager` | String | 是 | 基金管理人名称 |  |
| `data.items[].type` | String | 是 | 基金类型 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 72.6 基金协会会员列表

- Hub：`POST /api/v1/data/enterprise/72.6/query`；上游方法 GET；可调用
- 说明：基金协会会员列表，包括会员编号、机构类型、会员名称、会员类型、会员代表、入会时间等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `skip(可选)` | Number | 否 | 跳过条目数（默认为0） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 基金业协会会员列表 |  |
| `data.items[].is_director` | String | 是 | 是否理监事 |  |
| `data.items[].member_type` | String | 是 | 会员类型 |  |
| `data.items[].member_time` | Number | 是 | 入会时间 |  |
| `data.items[].name` | String | 是 | 会员名称 |  |
| `data.items[].member_deputy` | String | 是 | 会员代表 |  |
| `data.items[].member_no` | String | 是 | 会员编号 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 72.7 基金协会一般成员

- Hub：`POST /api/v1/data/enterprise/72.7/query`；上游方法 GET；可调用
- 说明：基金协会一般成员，包括会员编号、机构类型、会员名称、会员类型、会员代表、入会时间、注册地址、办公地址、注册资本(万人民币)、企业类型等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.employee_num` | Number | 是 | 员工人数 |  |
| `data.member_type` | String | 是 | 会员类型 |  |
| `data.is_member` | String | 是 | 是否会员 |  |
| `data.start_date` | String | 是 | 成立日期 |  |
| `data.address` | String | 是 | 注册地址 |  |
| `data.business_type` | String | 是 | 业务类型 |  |
| `data.reg_capi` | String | 是 | 注册资本(万人民币) |  |
| `data.en_name` | String | 是 | 基金管理人英文名 |  |
| `data.is_director` | String | 是 | 是否理监事 |  |
| `data.name` | String | 是 | 会员名称 |  |
| `data.member_deputy` | String | 是 | 会员代表 |  |
| `data.ent_type` | String | 是 | 企业性质 |  |
| `data.product_list` | String | 是 | 私募资管计划信息 |  |
| `data.websites` | String | 是 | 机构网址 | 🔗 |
| `data.credit_no` | String | 是 | 统一社会信用代码/组织机构代码 |  |
| `data.member_no` | String | 是 | 会员编号 |  |
| `data.office_address` | String | 是 | 办公地址 |  |
| `data.member_time` | String | 是 | 入会时间 |  |
| `data.type` | String | 是 | 机构类型 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 72.8 基金协会高管信息

- Hub：`POST /api/v1/data/enterprise/72.8/query`；上游方法 GET；可调用
- 说明：基金协会高管信息，包括管理人id、高管姓名、职务、是否有基金从业资格、资格获取方式等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 高管成员信息列表 |  |
| `data.items[].title` | String | 是 | 职务 |  |
| `data.items[].eid` | String | 是 | 管理人id |  |
| `data.items[].qualified_type` | String | 是 | 资格获取方式 |  |
| `data.items[].name` | String | 是 | 高管姓名 |  |
| `data.items[].member_no` | String | 是 | 登记编号 |  |
| `data.items[].is_qualified` | String | 是 | 是否有基金从业资格 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 72.9 证券私募子公司列表

- Hub：`POST /api/v1/data/enterprise/72.9/query`；上游方法 GET；可调用
- 说明：证券私募子公司列表，包括机构类型、会员名称、会员类型、会员代表、入会时间等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `skip` | Number | 否 | 跳过条目数（默认为0） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 证券公司私募子公司列表 |  |
| `data.items[].member_type` | String | 是 | 会员类型 |  |
| `data.items[].member_time` | String | 是 | 入会时间 |  |
| `data.items[].name` | String | 是 | 会员名称 |  |
| `data.items[].member_deputy` | String | 是 | 会员代表 |  |
| `data.items[].member_no` | String | 是 | 会员编号 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 72.10 证券私募子公司信息

- Hub：`POST /api/v1/data/enterprise/72.10/query`；上游方法 GET；可调用
- 说明：根据私募子公司名称获取证券公司私募子公司信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.employee_num` | String | 是 | 员工人数 |  |
| `data.member_type` | String | 是 | 会员类型 |  |
| `data.parent_name` | String | 是 | 所属一级私募子公司信息 |  |
| `data.is_member` | String | 是 | 是否会员 |  |
| `data.branch_type` | String | 是 | 子公司类型 |  |
| `data.address` | String | 是 | 注册地址 |  |
| `data.org_no` | String | 是 | 组织机构代码 |  |
| `data.business_type` | String | 是 | 业务类型 |  |
| `data.reg_capi` | String | 是 | 注册资本(万人民币) |  |
| `data.en_name` | String | 是 | 基金管理人英文名 |  |
| `data.fund_date` | String | 是 | 登记日期 |  |
| `data.real_capi_percent` | String | 是 | 实缴比例 |  |
| `data.websites` | String | 是 | 机构网址 | 🔗 |
| `data.name` | String | 是 | 名称 |  |
| `data.member_deputy` | String | 是 | 会员代表 |  |
| `data.fund_no` | String | 是 | 会员编码(登记编号) |  |
| `data.ent_type` | String | 是 | 企业性质 |  |
| `data.member_time` | String | 是 | 入会时间 |  |
| `data.office_address` | String | 是 | 办公地址 |  |
| `data.real_capi` | String | 是 | 实缴资本(万人民币) |  |
| `data.start_date` | String | 是 | 成立日期 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 72.11 一级与二级私募管理信息

- Hub：`POST /api/v1/data/enterprise/72.11/query`；上游方法 GET；可调用
- 说明：一级与二级私募管理信息，包括登记编号、一级公司名称、二级私募名称等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 一级私募子公司管理二级私募公司信息列表 |  |
| `data.items[].name` | String | 是 | 一级公司名称 |  |
| `data.items[].branch_name` | String | 是 | 二级私募名称 |  |
| `data.items[].fund_no` | String | 是 | 登记编号 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 72.12 私募子公司基金产品

- Hub：`POST /api/v1/data/enterprise/72.12/query`；上游方法 GET；可调用
- 说明：私募子公司基金产品，包括产品编码、产品名称、基金类型、组织形式、运作状态、管理人名称等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 私募子公司基金产品信息列表 |  |
| `data.items[].trust_name` | String | 是 | 托管人名称 |  |
| `data.items[].manager_name` | String | 是 | 管理人名称 |  |
| `data.items[].status` | String | 是 | 运作状态 |  |
| `data.items[].fund_no` | String | 是 | 产品编码 |  |
| `data.items[].start_date` | String | 是 | 成立日期 |  |
| `data.items[].is_trust` | String | 是 | 是否托管 |  |
| `data.items[].name` | String | 是 | 产品名称 |  |
| `data.items[].reg_date` | String | 是 | 备案日期 |  |
| `data.items[].ent_type` | String | 是 | 组织形式 |  |
| `data.items[].type` | String | 是 | 基金类型 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 72.13 注销私募列表

- Hub：`POST /api/v1/data/enterprise/72.13/query`；上游方法 GET；可调用
- 说明：注销私募列表，包括管理人名称、统一社会信用代码/组织机构代码、注销类型、注销时间等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `skip` | Number | 是 | 跳过条目数（默认为0） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 注销私募列表 |  |
| `data.items[].reg_date` | String | 是 | 登记时间 |  |
| `data.items[].cancel_type` | String | 是 | 注销类型 |  |
| `data.items[].credit_no` | String | 是 | 统一社会信用代码/组织机构代码 |  |
| `data.items[].name` | String | 是 | 管理人名称 |  |
| `data.items[].cancel_date` | String | 是 | 注销时间 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 69.21 股权质押信息

- Hub：`POST /api/v1/data/enterprise/69.21/query`；上游方法 GET；可调用
- 说明：上市企业股权质押信息，包括股东名称、股东代码、所持股数、涉及金额、是否触及/跌破平仓线等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 现金流量信息列表 |  |
| `data.items[].sharehdname` | String | 是 | 股东名称 |  |
| `data.items[].sharehdnum` | Number | 是 | 所持股数 |  |
| `data.items[].emorderid` | Number | 是 | 事件id |  |
| `data.items[].sharehdcode` | String | 是 | 股东代码 |  |
| `data.items[].invamount` | Number | 是 | 涉及金额 |  |
| `data.items[].istbreakunwindl` | String | 是 | 是否触及/跌破平仓线 |  |
| `data.items[].noticedate` | String | 是 | 公告日期 |  |
| `data.items[].sharefrozennum` | String | 是 | 质押/冻结股数 |  |
| `data.items[].frozprogres` | String | 是 | 质押冻结进度 |  |
| `data.items[].noreleasnum` | Number | 是 | 剩余未解押数 |  |
| `data.items[].amtsharefrozen` | Number | 是 | 累计质押股数 |  |
| `data.items[].frozendateexplain` | String | 是 | 质押/冻结期限描述 |  |
| `data.items[].freedtaeinad` | String | 是 | 实际解除日期 |  |
| `data.items[].updatedate` | String | 是 | 资料更新日期 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 69.22 股权质押详情

- Hub：`POST /api/v1/data/enterprise/69.22/query`；上游方法 GET；可调用
- 说明：上市股权质押详情，包括股东名称、所持股数、涉及金额、质押/冻结占所持股比例、质押目的、质押/冻结事由等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `emorderid` | String | 是 | 事件id |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 股权质押详情 |  |
| `data.items[].sharehdname` | String | 是 | 股东名称 |  |
| `data.items[].sharehdnum` | String | 是 | 所持股数 |  |
| `data.items[].emorderid` | String | 是 | 事件id |  |
| `data.items[].frozenintotal` | String | 是 | 质押/冻结占总股本比例 |  |
| `data.items[].invamount` | String | 是 | 涉及金额 |  |
| `data.items[].noticedate` | String | 是 | 公告日期 |  |
| `data.items[].istbreakunwindl` | String | 是 | 是否触及/跌破平仓线 |  |
| `data.items[].frozenreason` | String | 是 | 质押/冻结事由 |  |
| `data.items[].freedate` | String | 是 | 质押/冻结截止日 |  |
| `data.items[].frozenstartdate` | String | 是 | 质押/冻结起始日 |  |
| `data.items[].frozenname` | String | 是 | 实施质押冻结机构 |  |
| `data.items[].sharehdcode` | String | 是 | 股东代码 |  |
| `data.items[].frozeneid` | String | 是 | 质押冻结机构代码 |  |
| `data.items[].pledgepur` | String | 是 | 质押目的 |  |
| `data.items[].frozenratio` | String | 是 | 质押/冻结占所持股比例 |  |
| `data.items[].sharefrozennum` | String | 是 | 质押/冻结股数 |  |
| `data.items[].updatedate` | String | 是 | 资料更新日期 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 72.14 私募管理人产品

- Hub：`POST /api/v1/data/enterprise/72.14/query`；上游方法 GET；可调用
- 说明：私募管理人产品，包括基金编号、基金名称、基金类型、币种、基金管理人名称、管理类型、托管人名称、运作状态等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 私募管理人产品信息列表 |  |
| `data.items[].manage_type` | String | 是 | 管理类型 |  |
| `data.items[].status` | String | 是 | 运作状态 |  |
| `data.items[].should_report_monthly` | Number | 是 | 当月月报应披露 |  |
| `data.items[].unreport_monthly` | Number | 是 | 当月月报未披露 |  |
| `data.items[].unreport_annually` | Number | 是 | 年报未披露 |  |
| `data.items[].report_annually` | Number | 是 | 年报按时披露 |  |
| `data.items[].unreport_quarterly` | Number | 是 | 季报未披露 |  |
| `data.items[].should_report_annually` | Number | 是 | 年报应披露 |  |
| `data.items[].unreport_semiannually` | Number | 是 | 半年报未披露 |  |
| `data.items[].update_time` | String | 是 | 基金更新时间 |  |
| `data.items[].start_date` | String | 是 | 成立日期 |  |
| `data.items[].should_report_semiannually` | Number | 是 | 半年报应披露 |  |
| `data.items[].trust_name` | String | 是 | 托管人名称 |  |
| `data.items[].reg_step` | Number | 是 | 基金备案阶段 |  |
| `data.items[].name` | String | 是 | 基金名称 |  |
| `data.items[].reminder` | String | 是 | 基金业协会提示 |  |
| `data.items[].fund_no` | String | 是 | 基金编号 |  |
| `data.items[].reg_date` | String | 是 | 备案日期 |  |
| `data.items[].should_report_quarterly` | Number | 是 | 季报应披露 |  |
| `data.items[].report_quarterly` | Number | 是 | 季报按时披露 |  |
| `data.items[].report_monthly` | Number | 是 | 当月月报按时披露 |  |
| `data.items[].report_semiannually` | Number | 是 | 半年报按时披露 |  |
| `data.items[].currency` | String | 是 | 币种 |  |
| `data.items[].manager` | String | 是 | 基金管理人名称 |  |
| `data.items[].type` | String | 是 | 基金类型 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 86.42 债券违约信息

- Hub：`POST /api/v1/data/enterprise/86.42/query`；上游方法 GET；可调用
- 说明：根据企业名称获取债券违约信息，包括债券代码、事件类型、担保人等信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | string | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | number | 否 | 分页跳过的记录数（默认为0）分页20 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | string | 否 | 数据返回结果 |  |
| `sign` | string | 否 | 数据签名 |  |
| `data` | object | 否 | 返回查询结果 |  |
| `data.total` | number | 否 | 返回列表中记录总数 |  |
| `data.num` | number | 否 | 本次调用返回记录数 |  |
| `data.items` | array | 否 | 查询列表 |  |
| `data.items[].security_code` | string | 否 | 债券代码 |  |
| `data.items[].notice_date` | string | 否 | 公告日期 |  |
| `data.items[].attach_name` | string | 否 | 附件url | 🔗 |
| `data.items[].company_name` | string | 否 | 公司名称 |  |
| `data.items[].is_first` | string | 否 | 是否首次违约（1：是；0:否） |  |
| `data.items[].wtycomp_name` | string | 否 | 担保人 |  |
| `data.items[].notice_title` | string | 否 | 公告标题 |  |
| `data.items[].event_type` | string | 否 | 事件类型 |  |
| `data.items[].eid` | string | 否 | 企业id |  |
| `message` | string | 否 | 返回结果消息 |  |

### 27.35 股票行情

- Hub：`POST /api/v1/data/enterprise/27.35/query`；上游方法 GET；可调用
- 说明：获取企业股票详情

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 是 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `sign` | String | 否 | 数据签名 |  |
| `status` | String | 否 | 返回结果状态 |  |
| `message` | String | 否 | 返回结果消息 |  |
| `data` | Object | 否 | 返回查询结果，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 否 | 返回列表中记录总数 |  |
| `data.num` | Number | 否 | 本次调用返回记录数 |  |
| `data.items` | Array | 否 | 股票行情列表 |  |
| `data.items[].ent_name` | String | 否 | 企业名称 |  |
| `data.items[].eid` | String | 否 | 企业id |  |
| `data.items[].security_code` | String | 否 | 证券代码 |  |
| `data.items[].securitys_name` | String | 否 | 证券简称 |  |
| `data.items[].date` | String | 否 | 日期 |  |
| `data.items[].new_price` | String | 否 | 现价（元） |  |
| `data.items[].chg` | String | 否 | 涨跌（元） |  |
| `data.items[].chg_radio` | String | 否 | 涨跌幅 |  |
| `data.items[].lclose_price` | String | 否 | 昨日收盘价 |  |
| `data.items[].open_price` | String | 否 | 今日开盘价 |  |
| `data.items[].high_price` | String | 否 | 最高价 |  |
| `data.items[].low_price` | String | 否 | 最低价 |  |
| `data.items[].tvol` | String | 否 | 成交量 |  |
| `data.items[].tval_cny` | String | 否 | 成交额 |  |
| `data.items[].pe` | String | 否 | 市盈率 |  |
| `data.items[].pb` | String | 否 | 市净率 |  |
| `data.items[].tot_market_value` | String | 否 | 总市值 |  |
| `data.items[].cir_market_value` | String | 否 | 流通市值 |  |

### 47.26 董监高股权质押

- Hub：`POST /api/v1/data/enterprise/47.26/query`；上游方法 GET；可调用
- 说明：上市企业董监高的股权质押信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `p_name` | String | 是 | 自然人名 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].eid` | String | 是 | 企业id |  |
| `data.items[].name` | String | 是 | 企业名称 |  |
| `data.items[].pid` | String | 是 | 董监高标识 |  |
| `data.items[].p_name` | String | 是 | 董监高姓名 |  |
| `data.items[].emorderid` | String | 是 | 事件id |  |
| `data.items[].noticedate` | String | 是 | 公告日期 |  |
| `data.items[].isnew` | String | 是 | 是否最新；0：否，1：是 |  |
| `data.items[].frozentype` | String | 是 | 质押冻结类型："质押 冻结 托管 未知 质押回购 约定回购" |  |
| `data.items[].sharetype` | String | 是 | 质押股份类型：001 ADR 002 国家股 003 境内法人股 004 境外法人股 005 流通A股 006 流通B股 007 流通H股 008 流通S股 009 其它未流通股 010 普通股 011 优先股 014 不详 |  |
| `data.items[].frozenstartdate` | String | 是 | 质押/冻结起始日 |  |
| `data.items[].freedate` | String | 是 | 质押/冻结截止日 |  |
| `data.items[].ghdate` | String | 是 | 过户日期 |  |
| `data.items[].freedtaeinad` | String | 是 | 实际解除日期 |  |
| `data.items[].frozenname` | String | 是 | 实施质押冻结机构 |  |
| `data.items[].frozeneid` | String | 是 | 质押冻结机构代码 |  |
| `data.items[].invamount` | String | 是 | 涉及金额；单位：万元 |  |
| `data.items[].sharehdnum` | String | 是 | 所持股数；万股 |  |
| `data.items[].achgshare` | String | 是 | 变动后股数 |  |
| `data.items[].sharefrozennum` | String | 是 | 质押/冻结股数；万股 |  |
| `data.items[].noreleasnum` | String | 是 | 剩余未解押数 |  |
| `data.items[].amtsharefrozen` | String | 是 | 累计质押股数；万股 |  |
| `data.items[].istbreakunwindl` | String | 是 | 是否触及/跌破平仓线 |  |
| `data.items[].frozenratio` | String | 是 | 质押/冻结占所持股比例 |  |
| `data.items[].frozenintotal` | String | 是 | 质押/冻结占总股本比例 |  |
| `data.items[].achgratio` | String | 是 | 变动后股数占总股本比例 |  |
| `data.items[].amtsharerepo` | String | 是 | 累计质押/约定回购股数；万股 |  |
| `data.items[].amtshratio` | String | 是 | 累计质押数占所持股比例 |  |
| `data.items[].amtfrozenratio` | String | 是 | 累计质押股数占总股本比例 |  |
| `data.items[].amtreporatio` | String | 是 | 累计质押/约定回购股数占总股本比例 |  |
| `data.items[].ndateamtsharerepo` | String | 是 | 截止公告日累计质押数；股 |  |
| `data.items[].ndateamtshatoeqra` | String | 是 | 截止公告日累计质押数占总股本比例 |  |
| `data.items[].ndateamtshratio` | String | 是 | 截止公告日累计质押数占所持股比例 |  |
| `data.items[].frozendateexplain` | String | 是 | 质押/冻结期限描述 |  |
| `data.items[].pledgepur` | String | 是 | 质押目的；"001贷款 002担保 003授信额度" |  |
| `data.items[].meunfrpled` | String | 是 | 解除质押冻结方式 |  |
| `data.items[].frozprogres` | String | 是 | 质押冻结进度；初始质押 初始质押回购 初始约定回购 初始冻结 初始托管 轮候冻结 补充质押 预计解除 到期解除 部分解除 |  |
| `data.items[].frozenreason` | String | 是 | 质押/冻结事由 |  |
| `data.items[].remark` | String | 是 | 备注 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 52.86 董监高股权出质

- Hub：`POST /api/v1/data/enterprise/52.86/query`；上游方法 GET；可调用
- 说明：上市企业董监高的股权出质信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `p_name` | String | 是 | 自然人名 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].eid` | String | 是 | 企业id |  |
| `data.items[].pid` | String | 是 | 董监高标识 |  |
| `data.items[].name` | String | 是 | 企业名称 |  |
| `data.items[].u_id` | String | 是 | 唯一标识 |  |
| `data.items[].number` | String | 是 | 登记编号 |  |
| `data.items[].pledgor` | String | 是 | 出质人 |  |
| `data.items[].object_company` | String | 是 | 标的方企业id |  |
| `data.items[].pledgor_amount` | String | 是 | 出质股权数额 |  |
| `data.items[].pawnee` | String | 是 | 质权人 |  |
| `data.items[].pawnee_id` | String | 是 | 质权人标识 |  |
| `data.items[].date` | String | 是 | 股权出质登记日期 |  |
| `data.items[].relation_detail` | String | 是 | 关系 |  |
| `data.items[].status` | String | 是 | 状态 |  |
| `data.items[].is_history` | String | 是 | 是否为历史；0：否，1：是 |  |
| `data.items[].pledgor_unit` | String | 是 | 出质股权数额单位 |  |
| `data.items[].pledgor_currency` | String | 是 | 出质股权数额币种 |  |
| `data.items[].status_code` | String | 是 | 状态编码；1：正常或有效 2： 部分撤销 3：撤销或全部撤销 4：无效 5：注销 -1 ：其它 |  |
| `data.items[].pledgor_primal` | String | 是 | 出质人原始值 |  |
| `data.items[].pledgor_detail` | Array | 是 | 出质人详情 |  |
| `data.items[].pledgor_detail[].pledgor_name` | String | 是 | 出质人名称 |  |
| `data.items[].pledgor_detail[].pledgor_epid` | String | 是 | 出质人标识 |  |
| `data.items[].pledgor_detail[].pledgor_relation` | String | 是 | 关系 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 43.82 企业证券名称变更

- Hub：`POST /api/v1/data/enterprise/43.82/query`；上游方法 GET（可选 GET/POST）；可调用
- 说明：查询企业证券名称变更记录

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业名称。 |
| `skip` | Number | 否 | 跳过条目数，默认 0，每页固定返回 20 条。 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 企业证券名称变更查询结果 |  |
| `data.total` | Number | 是 | 满足条件的记录总数 |  |
| `data.num` | Number | 是 | 本次返回记录数 |  |
| `data.items` | Array | 是 | 证券名称变更记录列表 |  |
| `data.items[].ename` | String | 否 | 企业名称 |  |
| `data.items[].securityname` | String | 否 | 证券全称 |  |
| `data.items[].securitysname` | String | 否 | 证券简称 |  |
| `data.items[].securitycode` | String | 否 | 证券代码 |  |
| `data.items[].noticedate` | String | 否 | 公告日期 |  |
| `data.items[].changedate` | String | 否 | 变更日期 |  |
| `data.items[].reasoncode` | String | 否 | 变更原因编码 |  |
| `data.items[].reason` | String | 否 | 变更原因 |  |
| `data.items[].changeiterm` | String | 否 | 变更项目 |  |
| `data.items[].changeb` | String | 否 | 变更前 |  |
| `data.items[].changea` | String | 否 | 变更后 |  |
| `data.items[].remark` | String | 否 | 备注 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

## 地产建筑


### 80.1 建筑企业资质查询

- Hub：`POST /api/v1/data/enterprise/80.1/query`；上游方法 GET；可调用
- 说明：建筑企业资质查询信息，包括资质证书号、资质类别、资质名称、资质范围等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.list` | Array | 是 | 企业资质列表 |  |
| `data.list[].register_no` | String | 是 | 资质证书号 |  |
| `data.list[].valid_start` | String | 是 | 发证日期YYYY-MM-DD |  |
| `data.list[].issue_org` | String | 是 | 发证机关 |  |
| `data.list[].ename` | String | 是 | 公司名称 |  |
| `data.list[].scope` | String | 是 | 资质范围 |  |
| `data.list[].name` | String | 是 | 资质名称 |  |
| `data.list[].valid_end` | String | 是 | 证书有效期YYYY-MM-DD |  |
| `data.list[].type` | String | 是 | 资质类别 |  |
| `data.list[].state` | String | 是 | 证书是否有效 |  |
| `data.total` | Number | 是 | 企业资质总数 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 80.5 建筑企业不良行为

- Hub：`POST /api/v1/data/enterprise/80.5/query`；上游方法 GET（可选 POST/GET）；可调用
- 说明：建筑企业不良行为信息，包括诚信记录编号、处罚类型、处罚结果、处罚事由、文号、实施部门等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.list` | Array | 是 | 不良行为信息列表 |  |
| `data.list[].reason` | String | 是 | 处罚事由 |  |
| `data.list[].name` | String | 是 | 企业名称 |  |
| `data.list[].valid_end` | String | 是 | 发布有效期 |  |
| `data.list[].department` | String | 是 | 实施部门 |  |
| `data.list[].case_no` | String | 是 | 文号 |  |
| `data.list[].type` | String | 是 | 处罚类型 |  |
| `data.list[].result` | String | 是 | 处罚结果 |  |
| `data.list[].number` | String | 是 | 诚信记录编号 |  |
| `data.list[].decide_date` | String | 是 | 决定日期 |  |
| `data.total` | Number | 是 | 不良行为记录总数 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 80.6 建筑企业黑名单

- Hub：`POST /api/v1/data/enterprise/80.6/query`；上游方法 GET；可调用
- 说明：建筑企业黑名单信息，包括黑名单记录编号、认定依据、认定部门、列入日期、移除日期等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.list` | Array | 是 | 黑名单信息列表 |  |
| `data.list[].doc_no` | String | 是 | 列入文书号 |  |
| `data.list[].out_date` | String | 是 | 移除黑名单日期 |  |
| `data.list[].in_date` | String | 是 | 列入黑名单日期 |  |
| `data.list[].basis` | String | 是 | 黑名单认定依据 |  |
| `data.list[].name` | String | 是 | 企业名称 |  |
| `data.list[].number` | String | 是 | 黑名单记录编号 |  |
| `data.list[].department` | String | 是 | 认定部门 |  |
| `data.total` | Number | 是 | 黑名单记录总数 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 71.1 建设工程规划许可证

- Hub：`POST /api/v1/data/enterprise/71.1/query`；上游方法 GET；可调用
- 说明：建设工程规划许可证，包括建设单位、证书编号、项目名称、核发日期、快照等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].id` | String | 是 |  |  |
| `data.items[].eid` | String | 是 | 建设单位 ID |  |
| `data.items[].buildingUnit` | String | 是 | 建设单位 |  |
| `data.items[].registerNo` | String | 是 | 证书编号 |  |
| `data.items[].projectName` | String | 是 | 项目名称 |  |
| `data.items[].buildingLocation` | String | 是 | 建设位置 |  |
| `data.items[].buildingScope` | String | 是 | 建设规模 |  |
| `data.items[].issueDate` | String | 是 | 核发日期 |  |
| `data.items[].licensePhoto` | String | 是 | 建设工程规划许可证快照 | 🔗 |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

### 71.3 工程竣工验收信息

- Hub：`POST /api/v1/data/enterprise/71.3/query`；上游方法 GET；可调用
- 说明：工程竣工验收信息，包括建设单位、项目名称、施工单位、备案部门、竣工备案日期等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 竣工工程信息列表 |  |
| `data.items[].completeDate` | String | 是 | 竣工备案日期 |  |
| `data.items[].filingDepartment` | String | 是 | 备案部门 |  |
| `data.items[].eid` | String | 是 | 建设单位ID |  |
| `data.items[].id` | String | 是 |  |  |
| `data.items[].constructionUnit` | String | 是 | 施工单位 |  |
| `data.items[].projectName` | String | 是 | 项目名称 |  |
| `data.items[].number` | String | 是 | 编号 |  |
| `data.items[].buildingUnit` | String | 是 | 建设单位 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 71.5 土地闲置信息

- Hub：`POST /api/v1/data/enterprise/71.5/query`；上游方法 GET；可调用
- 说明：土地闲置信息，包括土地使用权人、土地位置、宗地面积、闲置原因等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 土地闲置信息列表 |  |
| `data.items[].landArea` | String | 是 | 宗地面积 |  |
| `data.items[].eid` | String | 是 | 土地使用权人ID |  |
| `data.items[].id` | String | 是 |  |  |
| `data.items[].idleReason` | String | 是 | 闲置原因 |  |
| `data.items[].promiseStartDate` | String | 是 | 合同约定开工时间 |  |
| `data.items[].landLocation` | String | 是 | 土地位置 |  |
| `data.items[].landUser` | String | 是 | 土地使用权人 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 71.7 建设用地规划许可证

- Hub：`POST /api/v1/data/enterprise/71.7/query`；上游方法 GET；可调用
- 说明：建设用地规划许可证，包括用地单位、用地位置、用地面积、核发日期、快照等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 规划许可证信息列表 |  |
| `data.items[].issueDate` | String | 是 | 核发日期 |  |
| `data.items[].registerNo` | String | 是 | 证书编号 |  |
| `data.items[].landLocation` | String | 是 | 用地位置 |  |
| `data.items[].landCharacter` | String | 是 | 用地性质 |  |
| `data.items[].landArea` | String | 是 | 用地面积 |  |
| `data.items[].eid` | String | 是 | 用地单位ID |  |
| `data.items[].licensePhoto` | String | 是 | 建设用地规划许可证快照 | 🔗 |
| `data.items[].buildingScope` | String | 是 | 建设规模 |  |
| `data.items[].id` | String | 是 |  |  |
| `data.items[].projectName` | String | 是 | 项目名称 |  |
| `data.items[].userUnit` | String | 是 | 用地单位 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 71.11 预售项目信息

- Hub：`POST /api/v1/data/enterprise/71.11/query`；上游方法 GET；可调用
- 说明：预售项目信息，包括开发企业、坐落位置、准许销售面积、快照等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 预售项目信息列表 |  |
| `data.items[].permitUnit` | String | 是 | 许可机关 |  |
| `data.items[].registerNo` | String | 是 | 证书编号 |  |
| `data.items[].issueDate` | String | 是 | 发证日期 |  |
| `data.items[].permitSaleArea` | String | 是 | 准许销售面积 |  |
| `data.items[].licensePhoto` | String | 是 | 商品房预售许可证快照 | 🔗 |
| `data.items[].fundsInstitutionBank` | String | 是 | 预售资金监管银行 |  |
| `data.items[].developEnterprise` | String | 是 | 开发企业 |  |
| `data.items[].permitSalePart` | String | 是 | 批准预售部位 |  |
| `data.items[].eid` | String | 是 | 开发企业ID |  |
| `data.items[].id` | String | 是 |  |  |
| `data.items[].landUseAndYears` | String | 是 | 土地用途和使用年限 |  |
| `data.items[].projectName` | String | 是 | 项目名称 |  |
| `data.items[].location` | String | 是 | 坐落位置 |  |
| `data.items[].validDate` | String | 是 | 有效期 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 71.13 土地成交信息

- Hub：`POST /api/v1/data/enterprise/71.13/query`；上游方法 GET；可调用
- 说明：土地成交信息，包括受让方名称、土地位置、出让年限、宗地面积、土地成交价等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 土地成交信息列表 |  |
| `data.items[].landBorder` | String | 是 | 宗地四至 |  |
| `data.items[].receiverName` | String | 是 | 受让方名称 |  |
| `data.items[].signingTime` | String | 是 | 签约时间 |  |
| `data.items[].id` | String | 是 |  |  |
| `data.items[].transferYears` | String | 是 | 出让年限 |  |
| `data.items[].planBuildingArea` | String | 是 | 规划建筑面积 |  |
| `data.items[].landArea` | String | 是 | 宗地面积 |  |
| `data.items[].eid` | String | 是 | 受让方ID |  |
| `data.items[].landLocation` | String | 是 | 土地位置 |  |
| `data.items[].planUse` | String | 是 | 规划用途 |  |
| `data.items[].landNo` | String | 是 | 地籍编号 |  |
| `data.items[].price` | String | 是 | 土地成交价 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 71.15 土地划拨信息

- Hub：`POST /api/v1/data/enterprise/71.15/query`；上游方法 GET；可调用
- 说明：土地划拨信息，包括土地使用者名称、宗地位置、项目名称、宗地面积等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 土地划拨信息列表 |  |
| `data.items[].landArea` | String | 是 | 宗地面积 |  |
| `data.items[].landUserName` | String | 是 | 土地使用者名称 |  |
| `data.items[].id` | String | 是 |  |  |
| `data.items[].projectName` | String | 是 | 项目名称 |  |
| `data.items[].landLocation` | String | 是 | 宗地位置 |  |
| `data.items[].eid` | String | 是 | 土地使用者名称ID |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 71.17 土地一级开发信息

- Hub：`POST /api/v1/data/enterprise/71.17/query`；上游方法 GET；可调用
- 说明：土地一级开发信息，包括主体名称、批准文号、项目名称等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 土地一级开发信息列表 |  |
| `data.items[].eid` | String | 是 | 主体ID |  |
| `data.items[].id` | String | 是 |  |  |
| `data.items[].permitNo` | String | 是 | 批准文号 |  |
| `data.items[].subjectName` | String | 是 | 主体名称 |  |
| `data.items[].projectName` | String | 是 | 项目名称 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 71.19 土地征收信息

- Hub：`POST /api/v1/data/enterprise/71.19/query`；上游方法 GET；可调用
- 说明：土地征收信息，包括用地单位、项目名称、用地位置、用地面积等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 土地征收信息列表 |  |
| `data.items[].landArea` | String | 是 | 用地面积 |  |
| `data.items[].eid` | String | 是 | 用地单位ID |  |
| `data.items[].id` | String | 是 |  |  |
| `data.items[].landLocation` | String | 是 | 用地位置 |  |
| `data.items[].permitNo` | String | 是 | 批准文号 |  |
| `data.items[].projectName` | String | 是 | 项目名称 |  |
| `data.items[].userUnit` | String | 是 | 用地单位 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 71.21 选址意见书

- Hub：`POST /api/v1/data/enterprise/71.21/query`；上游方法 GET；可调用
- 说明：选址意见书，包括建设单位、项目名称、建设位置、发文号等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 建设项目选址意见书列表 |  |
| `data.items[].eid` | String | 是 | 建设单位ID |  |
| `data.items[].id` | String | 是 |  |  |
| `data.items[].buildingUnit` | String | 是 | 建设单位 |  |
| `data.items[].textNo` | String | 是 | 发文号 |  |
| `data.items[].projectName` | String | 是 | 项目名称 |  |
| `data.items[].buildingLocation` | String | 是 | 建设位置 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 71.23 规划核验信息

- Hub：`POST /api/v1/data/enterprise/71.23/query`；上游方法 GET；可调用
- 说明：规划核验信息，包括建设单位、项目名称、建设位置、验收日期等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 规划核验信息列表 |  |
| `data.items[].checkDate` | String | 是 | 验收日期 |  |
| `data.items[].eid` | String | 是 | 建设单位ID |  |
| `data.items[].id` | String | 是 |  |  |
| `data.items[].buildingUnit` | String | 是 | 建设单位 |  |
| `data.items[].textNo` | String | 是 | 文号 |  |
| `data.items[].projectName` | String | 是 | 项目名称 |  |
| `data.items[].buildingLocation` | String | 是 | 建设位置 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 71.25 建筑名称核准信息

- Hub：`POST /api/v1/data/enterprise/71.25/query`；上游方法 GET；可调用
- 说明：建筑名称核准信息，包括申报单位、文号、详细地址、核准名称、核发日期等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 建筑名称信息列表 |  |
| `data.items[].address` | String | 是 | 详细地址 |  |
| `data.items[].eid` | String | 是 | 申报单位ID |  |
| `data.items[].declareUnit` | String | 是 | 申报单位 |  |
| `data.items[].checkName` | String | 是 | 核准名称 |  |
| `data.items[].textNo` | String | 是 | 文号 |  |
| `data.items[].issueDate` | String | 是 | 核发日期 |  |
| `data.items[].id` | String | 是 |  |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 71.27 地产相关行政处罚

- Hub：`POST /api/v1/data/enterprise/71.27/query`；上游方法 GET；可调用
- 说明：地产相关行政处罚，包括行政相对人名称、案由、处罚结果等

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（跳过的条数，默认不填返回前20条，取21到40条的数据，skip=20，以此类推进行取数） |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `data` | Object | 是 | 返回查询结果，每次调用返回20条记录，如果没有匹配记录则返回为空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.num` | Number | 是 | 本次调用返回记录数 |  |
| `data.items` | Array | 是 | 行政处罚列表 |  |
| `data.items[].caseCause` | String | 是 | 案由 |  |
| `data.items[].id` | String | 是 |  |  |
| `data.items[].decideDate` | String | 是 | 作出日期 |  |
| `data.items[].caseUnit` | String | 是 | 办案机关 |  |
| `data.items[].judgmentBasis` | String | 是 | 认定依据 |  |
| `data.items[].eid` | String | 是 | 行政相对人名称ID |  |
| `data.items[].punishResult` | String | 是 | 处罚结果 |  |
| `data.items[].punishTextNo` | String | 是 | 处罚决定文书编号 |  |
| `data.items[].administrativeCounterpartName` | String | 是 | 行政相对人名称 |  |
| `sign` | String | 是 | 数据签名 |  |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |

### 61.1 购地信息

- Hub：`POST /api/v1/data/enterprise/61.1/query`；上游方法 GET；可调用
- 说明：企业购地信息，有土地公示、结果公告，土地转让、地块抵押、房地产大企业购地以及房地产大地快出让等。根据不同入参类型，分别返回结果内容。

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回10条数据） |
| `type` | Number | 是 | 数据模块类型： 1：地块公示 2：土地结果公告 3：土地转让 4：土地抵押 5：房地产大企业购地 6：房地产大地块出让 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.total` | Number | 是 | 返回列表中记录总数 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].type` | String | 是 | 模块类型 type=1地块公示返回以下数据字段：（文档标识使用，实际不返回） |  |
| `data.items[].code` | String | 是 | 土地编号 |  |
| `data.items[].publish_date` | String | 是 | 发布日期 |  |
| `data.items[].province` | String | 是 | 行政区 |  |
| `data.items[].area` | String | 是 | 土地面积（公顷） |  |
| `data.items[].location` | String | 是 | 土地位置 |  |
| `data.items[].project_name` | String | 是 | 项目名称 |  |
| `data.items[].land_use` | String | 是 | 土地用途 |  |
| `data.items[].release_time` | String | 是 | 公示开始日期 |  |
| `data.items[].due_time` | String | 是 | 公示结束日期 |  |
| `data.items[].related_before` | Array | 是 | 受让单位 |  |
| `data.items[].related_before[].name` | String | 是 | 企业名称 |  |
| `data.items[].related_before[].eid` | String | 是 | 企业 id |  |
| `data.items[].type` | String | 是 | 模块类型 type=2 结果公示返回以下数据字段：（文档标识使用，实际不返回） |  |
| `data.items[].elect_no` | String | 是 | 电子监管号 |  |
| `data.items[].release_time` | String | 是 | 签订日期 |  |
| `data.items[].province` | String | 是 | 行政区 |  |
| `data.items[].area` | String | 是 | 土地面积（公顷） |  |
| `data.items[].land_source` | String | 是 | 土地来源 |  |
| `data.items[].land_level` | String | 是 | 土地级别 |  |
| `data.items[].price` | String | 是 | 成交价格（万元） |  |
| `data.items[].use_year` | String | 是 | 土地使用年限 |  |
| `data.items[].industry` | String | 是 | 行业分类 |  |
| `data.items[].location` | String | 是 | 土地位置 |  |
| `data.items[].project_name` | String | 是 | 项目名称 |  |
| `data.items[].land_use` | String | 是 | 土地用途 |  |
| `data.items[].approver` | String | 是 | 批准单位 |  |
| `data.items[].signing_mode` | String | 是 | 供地方式 |  |
| `data.items[].ydjdrq` | String | 是 | 约定交地时间 |  |
| `data.items[].ydkgrq` | String | 是 | 约定开工时间 |  |
| `data.items[].sjkgrq` | String | 是 | 实际开工时间 |  |
| `data.items[].ydjgrq` | String | 是 | 约定竣工时间 |  |
| `data.items[].sjjgrq` | String | 是 | 实际竣工时间 |  |
| `data.items[].ydrjl_sx` | String | 是 | 约定容积率上限 |  |
| `data.items[].ydrjl_xx` | String | 是 | 约定容积率下限 |  |
| `data.items[].related_before` | Array | 是 | 土地使用权 |  |
| `data.items[].related_before[].name` | String | 是 | 土地使用权企业名称 |  |
| `data.items[].related_before[].eid` | String | 是 | 土地使用权企业 id |  |
| `data.items[].type` | String | 是 | 模块类型 type=3 土地转让返回以下数据字段：（文档标识使用，实际不返回） |  |
| `data.items[].code` | String | 是 | 土地编号 |  |
| `data.items[].release_time` | String | 是 | 成交时间 |  |
| `data.items[].province` | String | 是 | 行政区 |  |
| `data.items[].area` | String | 是 | 土地面积（公顷） |  |
| `data.items[].use_type` | String | 是 | 土地使用权类型 |  |
| `data.items[].use_year` | String | 是 | 土地使用年限 |  |
| `data.items[].transfer_price` | String | 是 | 转让价格 |  |
| `data.items[].transfer_type` | String | 是 | 转让方式 |  |
| `data.items[].use_situation` | String | 是 | 土地利用状况 |  |
| `data.items[].land_level` | String | 是 | 土地级别 |  |
| `data.items[].location` | String | 是 | 土地位置 |  |
| `data.items[].land_use` | String | 是 | 土地用途 |  |
| `data.items[].related_before` | Array | 是 | 原土地使用权 |  |
| `data.items[].related_before[].name` | String | 是 | 原土地使用权名称 |  |
| `data.items[].related_before[].eid` | String | 是 | 原土地使用权企业 id |  |
| `data.items[].related_after` | Array | 是 | 现土地使用权 |  |
| `data.items[].related_after[].name` | String | 是 | 现土地使用权名称 |  |
| `data.items[].related_after[].eid` | String | 是 | 现土地使用权企业 id |  |
| `data.items[].type` | String | 是 | 模块类型 type=4 土地抵押返回以下数据字段：（文档标识使用，实际不返回） |  |
| `data.items[].code` | String | 是 | 土地编号 |  |
| `data.items[].province` | String | 是 | 行政区 |  |
| `data.items[].area` | String | 是 | 土地面积（公顷） |  |
| `data.items[].diya_area` | String | 是 | 抵押面积 |  |
| `data.items[].pro_amount` | String | 是 | 评估金额 |  |
| `data.items[].rent_amount` | String | 是 | 抵押金额 |  |
| `data.items[].location` | String | 是 | 土地位置 |  |
| `data.items[].land_use` | String | 是 | 土地用途 |  |
| `data.items[].user_code` | String | 是 | 土地他项权利人证号 |  |
| `data.items[].use_code` | String | 是 | 土地使用权证号 |  |
| `data.items[].diya_type` | String | 是 | 土地抵押人性质 |  |
| `data.items[].shuxing` | String | 是 | 抵押土地权属性质与使用权类型 |  |
| `data.items[].release_time` | String | 是 | 土地抵押登记起始时间 |  |
| `data.items[].dueTime` | String | 是 | 土地抵押登记结束时间 |  |
| `data.items[].related_before` | Array | 是 | 土地抵押人（数组） |  |
| `data.items[].related_before[].name` | String | 是 | 土地抵押人名 |  |
| `data.items[].related_before[].eid` | String | 是 | 土地抵押人企业 id |  |
| `data.items[].related_after` | Array | 是 | 土地抵押权（数组） |  |
| `data.items[].related_after[].name` | String | 是 | 土地抵押权人名 |  |
| `data.items[].related_after[].eid` | String | 是 | 土地抵押权企业 id |  |
| `data.items[].type` | String | 是 | 模块类型 type=5 房地产大企业购地返回以下数据字段：（文档标识使用，实际不返回） |  |
| `data.items[].elect_no` | String | 是 | 电子监管号 |  |
| `data.items[].province` | String | 是 | 行政区 |  |
| `data.items[].area` | String | 是 | 供地面积（公顷） |  |
| `data.items[].release_time` | String | 是 | 签订日期 |  |
| `data.items[].price` | String | 是 | 成交价款（万元） |  |
| `data.items[].signing_mode` | String | 是 | 供应方式 |  |
| `data.items[].location` | String | 是 | 土地位置 |  |
| `data.items[].land_use` | String | 是 | 土地用途 |  |
| `data.items[].ydkgrq` | String | 是 | 约定开工时间 |  |
| `data.items[].ydjgrq` | String | 是 | 约定竣工时间 |  |
| `data.items[].min_rj` | String | 是 | 最小容积率 |  |
| `data.items[].max_rj` | String | 是 | 最大容积率 |  |
| `data.items[].related_before` | Array | 是 | 受让人 |  |
| `data.items[].related_before[].name` | String | 是 | 受让人名称 |  |
| `data.items[].related_before[].eid` | String | 是 | 受让人企业 id |  |
| `data.items[].related_after` | Array | 是 | 上级公司 |  |
| `data.items[].related_after[].name` | String | 是 | 上级公司名称 |  |
| `data.items[].related_after[].eid` | String | 是 | 上级公司 id |  |
| `data.items[].type` | String | 是 | 模块类型 type=6 房地产大地块出让返回以下数据字段：（文档标识使用，实际不返回） |  |
| `data.items[].elect_no` | String | 是 | 电子监管号 |  |
| `data.items[].province` | String | 是 | 行政区 |  |
| `data.items[].area` | String | 是 | 供地面积（公顷） |  |
| `data.items[].release_time` | String | 是 | 签订日期 |  |
| `data.items[].price` | String | 是 | 成交价款（万元） |  |
| `data.items[].signing_mode` | String | 是 | 供应方式 |  |
| `data.items[].location` | String | 是 | 土地位置 |  |
| `data.items[].land_use` | String | 是 | 土地用途 |  |
| `data.items[].ydkgrq` | String | 是 | 约定开工时间 |  |
| `data.items[].ydjgrq` | String | 是 | 约定竣工时间 |  |
| `data.items[].min_rj` | String | 是 | 最小容积率 |  |
| `data.items[].max_rj` | String | 是 | 最大容积率 |  |
| `data.items[].related_before` | Array | 是 | 受让人（数组） |  |
| `data.items[].related_before[].name` | String | 是 | 受让人名称 |  |
| `data.items[].related_before[].eid` | String | 是 | 受让人企业 id |  |
| `data.items[].related_after` | Array | 是 | 上级公司（数组） |  |
| `data.items[].related_after[].name` | String | 是 | 上级公司名称 |  |
| `data.items[].related_after[].eid` | String | 是 | 上级公司 id |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |

## 特色专区


### 98.12 综合风险事件

- Hub：`POST /api/v1/data/enterprise/98.12/query`；上游方法 GET；可调用
- 说明：根据企业名称、注册号、统一社会信用代码获取企业风险类型，风险内容，风险事件，风险等级，业务披露事件等企业风险信息

**query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | String | 是 | 企业全名/注册号/统一社会信用代码 |
| `skip` | Number | 否 | 跳过条目数（默认为0，单页返回20条数据） |
| `risk_issue` | String | 否 | 风险事件类型，支持多个，英文逗号隔开，枚举值如下：0101001 法人变更 0101002 高层变更 0101003 高管无法履职 0102001 大股东变更 0102002 股份减持 0103001 实控人变更 0103002 受益所有人变更 0104001 裁员消息 0104002 参保人数骤降 0201002 投资企业简易注销 0201003 投资企业非经营状态 0202001 投资企业被纳入失信名单 0202002 投资企业无能力偿还债务 0202003 投资企业发生债务违约 0203005 投资企业被禁入市场 0203006 投资企业被纳入黑名单 0203008 投资企业整改或停业 0204001 投资企业经营异常 0204002 投资企业严重违法失信 0205001 投资企业欠税 0205002 投资企业被纳入非正常户 0205003 投资企业重大税收违法 0301001 被他人起诉 0301002 因劳动纠纷被他人起诉且败诉 0301003 票据承兑逾期 0301004 近五年违约规模较大 0301006 到期未履行的对外担保 0301007 因商业纠纷被他人起诉且败 0301008 因借贷纠纷被他人起诉且败 0301009 因知产纠纷被他人起诉且败 0301010 因其他类型纠纷被他人起诉且败 0302001 股权被冻结 0302002 资产被冻结 0302003 限制高消费 0302004 限制招投标 0302005 限制出境 0303001 被强制执行 0303002 资产被司法拍卖 0303003 拒绝偿还债务 0303004 无能力偿还债务 0303005 债券违约 0303006 股权被强制变更 0401001 起诉他人 0401002 起诉且胜诉 0401003 金融机构的对外贷款发生逾期（或违约） 0402001 申请财产保全 0402002 债务人疑似失踪或死亡 0402003 申请强制执行 0402004 申请他人破产 0501001 法人任职异常 0501002 高层任职异常 0501003 注册地址异常 0501004 代办地址注册 0501005 联系电话异常 0501006 治理结构异常 0501007 集中申请变更 0502001 动产抵押 0502002 股权质押 0502003 土地抵押 0502004 知识产权出质 0502005 股权出质 0502006 专利转让 0502007 土地转让 0503001 客户投诉 0503002 产品问题 0503003 产品召回 0503004 项目延期 0503005 停工停产 0503006 安全事故 0503007 无证施工 0503008 未准入境 0503009 企业迁移 0503010 经营方向大调整 0503011 专利被无效 0503012 资质证书到期 0503013 资质证书失效 0504001 注册资本下降 0504002 下降 0504003 列入观察名单 0504004 评级展望负面 0504005 评级下调 0504006 证券戴帽 0504007 退市风险 0504008 暂停上市 0504009 其他风险提示 0504010 股票停牌 0505001 供应商整改或停业 0505002 供应商疑似退出市场 0505003 供应商遭遇严重电力供应问题 0505004 供应商遭遇严重空气重污染 0505005 供应商遭遇严重毁灭性伤害 0505006 供应商遭遇严重新冠疫情 0505007 供应商遭遇严重破坏性灾害 0505008 供应商遭遇严重一般灾害 0505009 供应商无能力偿还债务 0506002 简易注销 0506003 非经营状态 0506004 营业执照到期 0506006 申请注销登记 0601002 环境污染 0601003 违规推广 0601004 市场垄断 0601006 商业贿赂 0601018 安全生产 0601019 质量不达标 0601020 围标串标 0601021 雇佣童工 0601022 劳动保障违法 0601023 非法集资 0601024 信息泄露 0601025 不正当竞争 0601026 其他违规行为 0601027 证券市场违规 0602001 抽查检查异常 0602002 双随机抽查异常 0603003 无法取得联系 0603004 未按规定披露信息 0603005 隐瞒真实情况 0603006 其他异常情况 0604001 欠税 0604004 无法取得联系 0604005 未按时纳税申报 0604006 偷税漏税 0604007 其他异常情况 0701001 电力供应问题 0701002 空气重污染 0701003 毁灭性伤害 0702001 新冠疫情 0703001 破坏性灾害 0703002 一般灾害 0704004 股价暴跌 |
| `business_time` | String | 否 | 披露时间范围，输入时间段，如2022-01-01,2024-01-01，用英文逗号","进行日期分隔 |
| `data_type` | String | 否 | 数据来源，支持多个，英文逗号隔开，枚举值如下：S001 新闻舆情 S002 突发事件 S003 合同违约指数 S004 空壳指数 T001 工商信息 N001 行政处罚 N002 上市公司雇员 N003 股权质押 N004 裁判文书 N005 限制高消费 N006 重大税收违法 N007 限制出境 N008 违法违规建设 N009 立案信息 N010 外部黑名单 N011 严重违法 N012 上市公司业绩预告 N013 上市公司债券违约 N014 限制招投标 N015 抽查检查 N016 环保处罚 N017 未准入境 N018 股权冻结、 N019 上市公司公告基础信息 N020 动产抵押 N021 上市公司董事监事 N022 劳动仲裁开庭公告 N023 票据承兑 N024 终本案件 N025 上市公司逾期贷款 N026 安全事故 N027 简易注销 N028 购地数据 N029 软件违规 N030 企业被执行 N031 知识产权出质 N032 非正常户 N033 开庭公告 N034 破产案件 N035 司法拍卖 N036 上市公司违规 N037 询价评估 N038 欠税 N039 股权出质 N040 上市公司高管 N041 劳动仲裁送达公告 N042 经营异常 N043 上市公司股东增减持计划 N044 安全监管 N045 企业失信 N046 动态监控 N047 法院公告 N048 上市公司担保 N049 上市公司主要财务指标 N050 股票行情 N051 清算组成员信息 N052 诉前调解 N053 债务人信息 N054 双随机抽查 N055 专利被无效 N056 专利转让 N057 专利保全 N058 资质证书 N059 注销备案 |
| `risk_level` | String | 否 | 风险等级，支持多个，英文逗号隔开，枚举值如下：1 历史风险、 2 疑似风险、 3 低风险、 4 高风险 |

**返回字段**（位于 Hub 响应 `data` 内）

| 字段路径 | 类型 | 声明必返 | 含义 | URL |
| --- | --- | --- | --- | --- |
| `status` | String | 是 | 返回结果状态 |  |
| `message` | String | 是 | 返回结果消息 |  |
| `sign` | String | 是 | 数据签名 |  |
| `data` | Object | 是 | 返回查询结果，如果没有匹配记录则返回空。具体字段含义见下表 |  |
| `data.items` | Array | 是 | 数据列表 |  |
| `data.items[].id` | String | 是 | 自增主键 |  |
| `data.items[].unique_id` | String | 是 | 唯一键 |  |
| `data.items[].eid` | String | 是 | 企业ID |  |
| `data.items[].branch_id` | String | 是 | 分支机构ID |  |
| `data.items[].branch_ename` | String | 是 | 分支机构名称 |  |
| `data.items[].related_eid` | String | 是 | 关联企业ID |  |
| `data.items[].related_type` | String | 是 | 关联企业类型 |  |
| `data.items[].related_ename` | String | 是 | 关联企业名称 |  |
| `data.items[].risk_type` | String | 是 | 风险类型（大类）,01公司治理风险、02对外投资风险、03信用风险、04应收账款风险、05经营风险、06合规风险、07不可抗力风险 |  |
| `data.items[].risk_category` | String | 是 | 风险内容（中类）,0101高层人事变动、0102股东减持或退出、0103实控人或受益人变更、0104人员规模缩减、0201投资企业疑似退出市场、0202投资企业出现债务危机、0203投资企业受到监管处罚、0204投资企业经营行为异常、0205投资企业纳税行为异常、0301疑似或实际发生违约、0302财产和行为被限制、0303拒绝或无能力偿还债务、0401疑似或实际被违约、0402债务可能面临损失、0501虚假经营嫌疑、0502流动资金不足、0503生产质量或进度问题、0504当前或预期业绩不佳、0505供应商疑似断供、0506疑似退出市场、0601监管关注和处罚、0602市场抽查结果异常、0603经营行为异常、0604纳税行为异常、0701社会异常事件、0702公共卫生事件、0703自然灾害、0704行业风险 |  |
| `data.items[].risk_issue` | String | 是 | 风险事件（小类）,0101001法人变更、0101002高层变更、0101003高管无法履职、0102001大股东变更、0102002股份减持、0103001实控人变更、0103002受益所有人变更、0104001裁员消息、0104002参保人数骤降、0201002投资企业简易注销、0201003投资企业非经营状态、0202001投资企业被纳入失信名单、0202002投资企业无能力偿还债务、0202003投资企业发生债务违约、0203005投资企业被禁入市场、0203006投资企业被纳入黑名单、0203008投资企业整改或停业、0204001投资企业经营异常、0204002投资企业严重违法失信、0205001投资企业欠税、0205002投资企业被纳入非正常户、0205003投资企业重大税收违法、0301001被他人起诉、0301002因劳动纠纷被他人起诉且败诉、0301003票据承兑逾期、0301004近五年违约规模较大、0301006到期未履行的对外担保、0301007因商业纠纷被他人起诉且败、0301008因借贷纠纷被他人起诉且败、0301009因知产纠纷被他人起诉且败、0301010因其他类型纠纷被他人起诉且败、0302001股权被冻结、0302002资产被冻结、0302003限制高消费、0302004限制招投标、0302005限制出境、0303001被强制执行、0303002资产被司法拍卖、0303003拒绝偿还债务、0303004无能力偿还债务、0303005债券违约、0303006股权被强制变更、0401001起诉他人、0401002起诉且胜诉、0401003金融机构的对外贷款发生逾期（或违约）、0402001申请财产保全、0402002债务人疑似失踪或死亡、0402003申请强制执行、0402004申请他人破产、0501001法人任职异常、0501002高层任职异常、0501003注册地址异常、0501004使用托管/代办地址注册、0501005联系电话异常、0501006治理结构异常、0501007集中申请变更、0502001动产抵押、0502002股权质押、0502003土地抵押、0502004知识产权出质、0502005股权出质、0502006专利转让、0502007土地转让、0503001客户投诉、0503002产品问题、0503003产品召回、0503004项目延期、0503005停工停产、0503006安全事故、0503007无证施工、0503008未准入境、0503009企业迁移、0503010经营方向大调整、0503011专利被无效、0503012资质证书到期、0503013资质证书失效、0504001注册资本下降、0504002业绩亏损/下降、0504003列入观察名单、0504004评级展望负面、0504005评级下调、0504006证券戴帽、0504007退市风险、0504008暂停上市、0504009其他风险提示、0504010股票停牌、0505001供应商整改或停业、0505002供应商疑似退出市场、0505003供应商遭遇严重电力供应问题、0505004供应商遭遇严重空气重污染、0505005供应商遭遇严重毁灭性伤害、0505006供应商遭遇严重新冠疫情、0505007供应商遭遇严重破坏性灾害、0505008供应商遭遇严重一般灾害、0505009供应商无能力偿还债务、0506002简易注销、0506003非经营状态、0506004营业执照到期、0506006申请注销登记、0601002环境污染、0601003违规推广、0601004市场垄断、0601006商业贿赂、0601018安全生产、0601019质量不达标、0601020围标串标、0601021雇佣童工、0601022劳动保障违法、0601023非法集资、0601024信息泄露、0601025不正当竞争、0601026其他违规行为、0601027证券市场违规、0602001抽查检查异常、0602002双随机抽查异常、0603003无法取得联系、0603004未按规定披露信息、0603005隐瞒真实情况、0603006其他异常情况、0604001欠税、0604004无法取得联系、0604005未按时纳税申报、0604006偷税漏税、0604007其他异常情况、0701001电力供应问题、0701002空气重污染、0701003毁灭性伤害、0702001新冠疫情、0703001破坏性灾害、0703002一般灾害、0704004股价暴跌 |  |
| `data.items[].data_type` | String | 是 | 数据来源 |  |
| `data.items[].issue_id` | String | 是 | 事件ID |  |
| `data.items[].detail` | String | 是 | 具体内容 |  |
| `data.items[].conclusion` | String | 是 | 提示信息 |  |
| `data.items[].risk_level` | String | 是 | 风险等级,1历史风险、2疑似风险、3低风险、4高风险 |  |
| `data.items[].business_time` | String | 是 | 业务披露时间 |  |
| `data.items[].district_code` | String | 是 | 区域代码 |  |
| `data.items[].row_update_time` | String | 是 | 记录更新时间 |  |
| `data.num` | Number | 是 | 当前返回列表的总条数 |  |
