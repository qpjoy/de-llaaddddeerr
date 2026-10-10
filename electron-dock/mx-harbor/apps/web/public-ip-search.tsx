"use client";

import { useRef, useState } from "react";
import { Globe, History, Search, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { validIpv4 } from "./api";
import { usePublicAccess } from "./public-access";

const queryFeatures = [
  {
    title: "风险概览",
    description: "汇总风险等级与行为标签，",
    detail: "帮助梳理需要关注的风险线索。",
    Icon: ShieldCheck,
  },
  {
    title: "网络背景",
    description: "查看归属地、运营商与网络类型，",
    detail: "了解 IP 的来源和网络环境。",
    Icon: Globe,
  },
  {
    title: "查询记录",
    description: "保留查询时间与历史记录，",
    detail: "回看最近结果，方便继续排查。",
    Icon: History,
  },
];

export function PublicIpSearch({
  initialIp = "",
  available = true,
}: {
  initialIp?: string;
  available?: boolean;
}) {
  const { signedIn, enter } = usePublicAccess();
  const [ip, setIp] = useState(initialIp);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = ip.trim();
    setIp(value);
    // All guest submissions go through authentication before querying.
    if (!available) return;
    if (signedIn && !validIpv4(value)) {
      setError("请输入有效的 IPv4 地址，例如 192.0.2.1");
      inputRef.current?.focus();
      return;
    }
    setError("");
    enter("intelligence", validIpv4(value) ? value : "");
  }
  return (
    <section
      className="public-query ip-query-surface"
      aria-labelledby="public-query-title"
    >
      <h1 id="public-query-title">IP 风险画像</h1>
      <p>查询风险等级、行为标签与网络归属</p>
      <form
        onSubmit={submit}
        noValidate
        role="search"
        aria-label="IP 风险画像查询"
      >
        <FieldGroup>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor="public-ip" className="sr-only">
              IP 地址
            </FieldLabel>
            <InputGroup className="intelligence-input">
              <InputGroupInput
                ref={inputRef}
                id="public-ip"
                value={ip}
                onChange={(event) => {
                  setIp(event.target.value);
                  setError("");
                }}
                placeholder="输入 IPv4 地址"
                autoComplete="off"
                autoCapitalize="none"
                enterKeyHint="search"
                spellCheck={false}
                maxLength={64}
                aria-invalid={!!error}
                aria-describedby={
                  error ? "public-ip-error" : "public-query-hint"
                }
              />
              <InputGroupAddon>
                <Search aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupAddon align="inline-end">
                {ip && (
                  <InputGroupButton
                    aria-label="清空 IP"
                    size="icon-sm"
                    onClick={() => {
                      setIp("");
                      setError("");
                      inputRef.current?.focus();
                    }}
                  >
                    <X />
                  </InputGroupButton>
                )}
                <Button
                  type="submit"
                  disabled={!available}
                  className="intelligence-submit"
                  aria-label="查询 IP 画像"
                >
                  <span>{available ? "查询" : "准备中"}</span>
                </Button>
              </InputGroupAddon>
            </InputGroup>
            {error && <FieldError id="public-ip-error">{error}</FieldError>}
          </Field>
        </FieldGroup>
      </form>
      <p id="public-query-hint" className="public-query-hint">
        {signedIn
          ? available
            ? "输入 IP 后进入控制台查询"
            : "数据查询尚未开放"
          : "受邀加入数港，已有 MX 账号也需首次开通"}
      </p>
      <ul className="public-query-intro" aria-label="查询功能介绍">
        {queryFeatures.map(({ title, description, detail, Icon }) => (
          <li key={title}>
            <div className="public-query-feature-heading">
              <Icon aria-hidden="true" />
              <h2>{title}</h2>
            </div>
            <p>
              <span>{description}</span>
              <span>{detail}</span>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
