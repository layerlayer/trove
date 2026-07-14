import { ArrowLeft, Check, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { StatusBar } from "../components/StatusBar";
import { interests } from "../data/mock";
import { useTrove } from "../context/TroveContext";

export function PreferencesPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { state, toggleInterest, completeOnboarding } = useTrove();
  const [query, setQuery] = useState("");

  const filteredInterests = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ko-KR");
    if (!normalized) return interests;
    return interests.filter((interest) =>
      [interest.label, ...interest.keywords]
        .join(" ")
        .toLocaleLowerCase("ko-KR")
        .includes(normalized),
    );
  }, [query]);

  const finish = () => {
    if (state.interests.length === 0) return;
    completeOnboarding();
    const returnTo = (location.state as { returnTo?: string } | null)?.returnTo ?? "/home";
    navigate(returnTo, { replace: true });
  };

  return (
    <main className="app-page onboarding-page">
      <StatusBar />
      <header className="simple-header">
        <button
          className="icon-button"
          type="button"
          aria-label="뒤로 가기"
          onClick={() => navigate((location.state as { returnTo?: string } | null)?.returnTo ?? "/home")}
        >
          <ArrowLeft size={28} strokeWidth={1.8} />
        </button>
      </header>

      <section className="onboarding-content">
        <h1>
          기다리는 즐거움을
          <br />
          모아보세요.
        </h1>
        <label className="search-field">
          <Search size={22} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="검색어를 입력해주세요."
            aria-label="관심사 검색"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        {filteredInterests.length > 0 ? (
          <div className="interest-grid">
            {filteredInterests.map((interest) => {
              const selected = state.interests.includes(interest.id);
              return (
                <button
                  className={`interest-tile ${selected ? "is-selected" : ""}`}
                  type="button"
                  key={interest.id}
                  aria-pressed={selected}
                  onClick={() => toggleInterest(interest.id)}
                >
                  <span className="interest-tile__image-wrap">
                    <img src={interest.image} alt="" />
                    {selected ? (
                      <span className="interest-tile__check" aria-hidden="true">
                        <Check size={20} strokeWidth={3} />
                      </span>
                    ) : null}
                  </span>
                  <span>{interest.label}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="empty-state empty-state--search">
            <Search size={28} />
            <strong>찾는 관심사가 아직 없어요</strong>
            <p>다른 검색어로 다시 찾아보세요.</p>
          </div>
        )}
      </section>

      <footer className="sticky-action onboarding-action">
        <button
          className="primary-button"
          type="button"
          disabled={state.interests.length === 0}
          onClick={finish}
        >
          <strong>{state.interests.length}개</strong> 선택 완료
        </button>
      </footer>
    </main>
  );
}
