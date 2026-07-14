import { Chrome, LogIn, Mail } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTrove } from "../context/TroveContext";
import { track } from "../lib/analytics";
import { BottomSheet } from "./BottomSheet";

interface AuthSheetProps {
  open: boolean;
  intentLabel?: string;
  onClose: () => void;
  onAuthenticated: () => void;
}

export function AuthSheet({
  open,
  intentLabel = "기다림을 저장하려면",
  onClose,
  onAuthenticated,
}: AuthSheetProps) {
  const { signIn } = useTrove();
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) track("signup_started", { intent: intentLabel });
  }, [intentLabel, open]);

  const finish = (nextEmail: string, provider: "email" | "google") => {
    signIn(nextEmail, provider);
    track("signup_completed", { provider });
    onAuthenticated();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(normalized)) {
      setError("이메일 주소를 확인해주세요.");
      return;
    }
    finish(normalized, "email");
  };

  return (
    <BottomSheet
      open={open}
      title={intentLabel}
      description="한 번 로그인하면 저장한 기다림과 알림 설정을 계속 확인할 수 있어요."
      onClose={onClose}
    >
      <div className="auth-sheet-content">
        <button
          className="auth-provider-button"
          type="button"
          onClick={() => finish("hello@trove.app", "google")}
        >
          <Chrome size={20} /> Google로 계속하기
        </button>

        <div className="auth-divider"><span>또는</span></div>

        <form className="auth-form" onSubmit={submit}>
          <label>
            <span>이메일</span>
            <span className="auth-input-wrap">
              <Mail size={19} />
              <input
                type="email"
                value={email}
                autoComplete="email"
                placeholder="name@example.com"
                onChange={(event) => {
                  setEmail(event.target.value);
                  setError("");
                }}
              />
            </span>
          </label>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button className="primary-button" type="submit">
            <LogIn size={19} /> 이메일로 계속하기
          </button>
        </form>

        <p className="auth-demo-note">
          현재 MVP는 인증 흐름을 검증하는 버전으로, 입력 정보는 이 브라우저에만 저장됩니다.
        </p>
      </div>
    </BottomSheet>
  );
}
