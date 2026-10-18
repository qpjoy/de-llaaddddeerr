export function LegalFooter({ inConsole = false }: { inConsole?: boolean }) {
  return (
    <footer
      className={inConsole ? "page-footer legal-footer" : "public-footer"}
    >
      <div
        className={
          inConsole
            ? "legal-footer-inner"
            : "public-container legal-footer-inner"
        }
      >
        <span>© 2026 数港 DataPort</span>
        <nav aria-label="法律信息">
          <a href="/privacy">隐私政策</a>
          <a href="/terms">用户协议</a>
          <a href="/cookies">Cookie 说明</a>
        </nav>
      </div>
    </footer>
  );
}

const documents: Record<
  string,
  { title: string; sections: [string, string][] }
> = {
  privacy: {
    title: "隐私政策",
    sections: [
      [
        "我们处理的信息",
        "数港处理统一 MX 认证提供的账号标识和显示名称、独立子账号的登录账号及密码验证信息、企业成员与角色信息、查询参数及结果、订阅与账单记录、技术日志和你主动提交的工单联系方式。企业超管和已关联 MX 账号使用统一 MX 认证；独立子账号使用数港账号认证。",
      ],
      [
        "使用目的",
        "以上信息用于身份验证、企业权限控制、交付查询结果、计量结算、客服支持及安全审计。企业内获得相应权限的成员可以查看企业共享的查询历史；工单按本人或企业查看权限展示。",
      ],
      [
        "数据与服务提供方",
        "IP 查询由后台配置的数据服务交付。地图底图会加载第三方 OpenStreetMap 图块，图块请求包含地图区域和浏览器网络信息；数港不会把被查询的 IP 作为地图请求参数。支付由独立支付服务处理。",
      ],
      [
        "账号与数据权利",
        "企业超管可管理本企业成员及角色。MX 账号密码在统一 MX 账户中维护；数港独立子账号密码在数港中修改，忘记密码可联系企业超管重置。独立子账号的初始密码加密保存，仅企业超管可在有效期内查看，员工改密后失效。账号或数据相关请求可通过数港客服工单提出。",
      ],
      [
        "保护与保留",
        "访问受企业权限控制，重要管理操作记录审计日志。数据按照服务履约、结算和安全所需期限保留；具体删除或导出申请请联系客服。",
      ],
    ],
  },
  terms: {
    title: "用户协议",
    sections: [
      [
        "服务与账号",
        "企业超管使用统一 MX 账号登录数港；员工可使用企业超管创建的数港独立子账号，或受邀关联已有 MX 账号加入。请保护账号、专属邀请码及 API Key，并仅在获授权的企业和业务范围内操作。",
      ],
      [
        "查询与风险参考",
        "IP 画像依赖数据源覆盖与更新时间，缺失字段、低风险或无标签均不代表绝对安全。风险参考建议按规则生成，目前未接入 AI。请结合自身业务日志与其他证据判断。",
      ],
      [
        "订阅与结算",
        "套餐价格、有效期、次数及每日额度以购买时服务端展示并确认的订单为准。网页与 API 共用企业订阅，历史回看不发起新查询。升级及续订的生效方式以确认页为准，已交付订单与权益不被界面修改。",
      ],
      [
        "使用约定",
        "请依法使用数据与接口，遵守授权、速率与配额限制，不得分享凭证、越权访问或干扰服务。查询结果待确认时，请先核对历史和账单，避免重复提交付费请求。",
      ],
      [
        "支持与变更",
        "可通过客服工单反馈账户、接入和账单问题。发票功能尚未接入，页面不接受开票资料。服务调整以实际展示和通知为准。",
      ],
    ],
  },
  cookies: {
    title: "Cookie 说明",
    sections: [
      [
        "必要 Cookie",
        "数港使用自己的会话 Cookie 维持登录，使用登录事务 Cookie 完成统一 MX 认证跳转，并通过 CSRF 校验保护写操作。禁用必要 Cookie 可能导致登录或管理功能不可用。",
      ],
      [
        "本地存储",
        "浏览器本地或会话存储用于保留页面返回目标、查询操作编号、支付返回定位信息。查询操作编号用于避免同一次操作重复发起计费。",
      ],
      [
        "第三方内容",
        "地图开启时从 OpenStreetMap 加载底图。统一认证和支付跳转由对应服务管理各自会话。数港当前没有提供可选分析或广告 Cookie 开关。",
      ],
      [
        "管理方式",
        "你可以在浏览器设置中查看、删除或禁用站点 Cookie 和本地存储。清理后可能需要重新登录，并丢失尚未确认操作的本地定位信息。",
      ],
    ],
  },
};
export function LegalDocument({ kind }: { kind: string }) {
  const doc = documents[kind] || documents.terms;
  return (
    <div className="dp-legal-page">
      <a href="/">← 返回数港</a>
      <h1>{doc.title}</h1>
      <p>生效日期：2026 年 10 月 14 日</p>
      {doc.sections.map(([title, body]) => (
        <section key={title}>
          <h2>{title}</h2>
          <p>{body}</p>
        </section>
      ))}
      <LegalFooter />
    </div>
  );
}
