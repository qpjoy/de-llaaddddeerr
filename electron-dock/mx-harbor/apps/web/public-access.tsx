import {
  createContext,
  useContext,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
export const AccessContext = createContext({
  signedIn: false,
  enter: (_destination: string, _ip?: string) => {},
  account: () => {},
});
export const usePublicAccess = () => useContext(AccessContext);
export function AccessButton({
  destination = "intelligence",
  account = false,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "onClick"> & {
  destination?: string;
  account?: boolean;
  children?: ReactNode;
}) {
  const access = usePublicAccess();
  return (
    <Button
      {...props}
      onClick={() => (account ? access.account() : access.enter(destination))}
    >
      {children || (access.signedIn ? "进入控制台" : "登录")}
    </Button>
  );
}
