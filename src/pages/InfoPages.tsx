import "./InfoPages.css";
import { ArrowLeft, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { StatusBar } from "../components/StatusBar";
import { useReleases } from "../data/ReleaseDataContext";
import { track } from "../lib/analytics";
import { useBack } from "../lib/useBack";

type InfoPageId = "about" | "terms" | "privacy";

/** 세 문서가 마지막으로 손질된 날. 문구를 고치면 같이 올린다 */
const UPDATED_AT = "2026-10-22";

/** 화면을 처음 열 때 한 번만 기록한다 */
function useInfoView(page: InfoPageId) {
  useEffect(() => {
    track("info_view", { page });
  }, [page]);
}

/** 콘솔 발행 시각(ISO)을 한국 시간으로. 메타 파일이 없거나 값이 이상하면 null */
function formatPublishedAt(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" });
  } catch {
    return date.toLocaleString("ko-KR");
  }
}

interface InfoLayoutProps {
  title: string;
  eyebrow?: string;
  /** 검토 전 초안이면 본문 위에 눈에 띄는 안내를 붙인다 */
  draft?: boolean;
  /** "YYYY-MM-DD" */
  updatedAt: string;
  children: ReactNode;
}

/** 소개·약관·방침이 함께 쓰는 틀: 상태 바, 뒤로 가기, 제목, 초안 안내, 본문 */
function InfoLayout({ title, eyebrow, draft = false, updatedAt, children }: InfoLayoutProps) {
  const goBack = useBack("/home");
  return (
    <main className="app-page info-page">
      <StatusBar />
      <header className="simple-header info-header">
        <button className="icon-button" type="button" aria-label="뒤로 가기" onClick={goBack}>
          <ArrowLeft size={28} strokeWidth={1.8} />
        </button>
      </header>

      <div className="info-head">
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h1>{title}</h1>
        <p className="info-head__updated">
          마지막 수정 <time dateTime={updatedAt}>{updatedAt}</time>
        </p>
      </div>

      {draft ? (
        <div className="info-draft" role="note">
          <TriangleAlert size={18} strokeWidth={2.2} aria-hidden="true" />
          <p>
            <strong>검토 전 초안이에요.</strong> 정식 문서가 아니에요.
          </p>
        </div>
      ) : null}

      <article className="info-body">{children}</article>
    </main>
  );
}

export function AboutPage() {
  useInfoView("about");
  const { releases, publishedAt } = useReleases();

  const sources = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of releases) counts.set(item.sourceName, (counts.get(item.sourceName) ?? 0) + 1);
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko"));
  }, [releases]);

  const dataStamp = formatPublishedAt(publishedAt);

  return (
    <InfoLayout title="Trove 소개" eyebrow="ABOUT TROVE" updatedAt={UPDATED_AT}>
      <section>
        <h2>한 줄로 말하면</h2>
        <p className="info-lead">기다리는 즐거움을 가져다 주는 서비스, 내 취향의 묶음.</p>
        <p>
          앨범·공연 티켓오픈·게임·영화·라이프스타일 출시 일정을 한곳에 모아 기다림을 즐겁게 만들어 줘요.
          마음에 드는 일정을 Trove에 담아 두면 알림 센터에서 D-7·D-1·D-Day 소식을 모아 볼 수 있어요. 기본은 D-1·D-Day이고, 시점은 프로필 &gt; 알림에서 바꿀 수 있어요. 브라우저 푸시 알림은 준비 중이에요.
        </p>
        <Link className="info-cta" to="/discover">일정 둘러보기</Link>
      </section>

      <section>
        <h2>어떻게 모으나요</h2>
        <ul>
          <li>예매처 공지와 공개된 일정 데이터에서 하루 한 번 일정을 모아요. 어디서 모았는지는 아래 ‘출처’에서 볼 수 있어요.</li>
          <li>사람이 검수한 뒤에만 발행해요.</li>
          <li>날짜를 중심으로 보여 주고, 시각은 공연 티켓오픈처럼 꼭 필요한 경우에만 표시해요.</li>
          <li>미정이거나 달·분기 단위인 일정은 그대로 “2026년 11월”처럼 보여 줘요.</li>
        </ul>
      </section>

      <section>
        <h2>이미지가 없는 이유</h2>
        <p>앨범 재킷·포스터·인물 사진은 저작권과 초상권이 있어서 허락 없이 쓰지 않아요.</p>
        <p>지금은 글자 타일로 표현하고, 공식 이미지 사용권을 확보하는 대로 바꿀 계획이에요.</p>
      </section>

      <section>
        <h2>출처</h2>
        {sources.length > 0 ? (
          <>
            <p>지금 발행된 일정은 이런 곳에서 모았어요.</p>
            <ul className="info-source-list" aria-label="출처별 일정 수">
              {sources.map((source) => (
                <li key={source.name}>
                  <strong>{source.name}</strong>
                  <span>· {source.count}건</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>아직 발행된 일정이 없어요.</p>
        )}
        <p>일정 상세에는 정보 출처와 마지막 확인일을 보여 줘요. 출처 링크가 있는 일정은 상세에서 바로 열 수 있어요.</p>
        {dataStamp ? <p className="info-stamp">데이터 기준 {dataStamp}</p> : null}
      </section>

      <section>
        <h2>내 데이터</h2>
        <p>관심사·담은 기다림·알림 설정 목록은 지금 이 기기의 브라우저에만 저장돼요. 다른 기기에서 이어 보는 계정은 준비 중이에요.</p>
        <p>서비스를 개선하려고 앱 안 사용 기록(본 화면, 검색어, 팔로우·담기 같은 행동과 그 대상 일정·아티스트·카테고리)은 Trove 서버(Supabase, 서울)에 보내요. 처음 열 때 생기는 이름 없는 임시 계정에 묶여요.</p>
        <p>
          <Link to="/profile">프로필</Link> &gt; MVP 데이터 초기화로 언제든 지울 수 있어요. 지금 쓰는 브라우저(또는 홈 화면 앱)에서 남긴 서버의 사용 기록도 함께 지워요. Safari, 홈 화면 앱, 카카오톡 안 브라우저는 따로라서 각각에서 초기화해 주세요. 브라우저 데이터를 지우거나(시크릿 창을 닫을 때 포함) 브라우저가 저장 공간을 스스로 비우면(예: Safari에서 한동안 이 사이트를 열지 않았을 때) 다음에 열 때 새 임시 계정이 생기고, 그 전 서버의 사용 기록은 앱에서 지울 수 없어요.
        </p>
        <p>
          자세한 내용은 <Link to="/privacy">개인정보 처리방침</Link>과 <Link to="/terms">이용약관</Link>에서 볼 수 있어요.
        </p>
      </section>

      <section>
        <h2>문의</h2>
        <p>문의처는 준비 중이에요. 정식 공개 때 이 페이지에서 알려 드릴게요.</p>
      </section>

      <footer className="info-footer">Trove MVP</footer>
    </InfoLayout>
  );
}

export function TermsPage() {
  useInfoView("terms");
  return (
    <InfoLayout title="이용약관" eyebrow="TERMS" draft updatedAt={UPDATED_AT}>
      <section>
        <h2>1. 목적</h2>
        <p>이 약관은 Trove(이하 “서비스”)를 쓰는 분과 Trove 사이의 기본적인 약속을 정해요. 서비스를 쓰면 이 약관에 동의한 것으로 봐요.</p>
      </section>

      <section>
        <h2>2. 서비스 내용</h2>
        <p>Trove는 앨범·공연 티켓오픈·게임·영화·라이프스타일의 출시 일정 정보를 모아 보여 주는 서비스예요.</p>
        <ul>
          <li>정보는 각 출처(예매처 공지, 공개된 일정 데이터 등)를 기준으로 하지만, 주최사·발매사 사정으로 바뀔 수 있어요. Trove가 정확성·완전성을 보증하지는 않아요.</li>
          <li>예매·구매는 각 출처에서 이루어져요. Trove는 거래 당사자가 아니에요.</li>
          <li>알림은 참고용이에요. 기기나 브라우저 상태에 따라 울리지 않을 수도 있어요.</li>
        </ul>
      </section>

      <section>
        <h2>3. 계정과 데이터</h2>
        <p>지금 단계에서 데모 로그인과 저장 데이터(관심사, 담은 기다림, 알림 설정)는 이 기기 안에만 저장돼요. 기기를 바꾸면 이어지지 않아요.</p>
        <p>서비스를 개선하려고 앱 안 사용 기록은 Trove 서버로 보내요. 팔로우·담기·알림 켜기 같은 행동은 그 대상(일정·아티스트·카테고리 ID)과 함께 기록돼요. 처음 열 때 이름 없는 임시 계정이 자동으로 생기고, 기록은 그 계정에 묶여요.</p>
        <p>기기나 브라우저 데이터를 지우면 이 기기의 데이터는 함께 사라지고, 지운 데이터는 되돌리기 어려워요. 서버의 사용 기록은 기록을 남긴 브라우저(또는 홈 화면 앱)에서 프로필 &gt; MVP 데이터 초기화로 지울 수 있어요. 브라우저 데이터를 지우거나(시크릿 창을 닫을 때 포함) 브라우저가 저장 공간을 스스로 비워 새 임시 계정이 생긴 뒤에는 그 전 기록을 앱에서 지울 수 없어요. 서버의 사용 기록까지 지우려면 브라우저 데이터를 지우거나 시크릿 창을 닫기 전에 먼저 MVP 데이터 초기화를 해 주세요.</p>
        <p>
          어떤 정보를 어떻게 다루는지는 <Link to="/privacy">개인정보 처리방침</Link>에서 볼 수 있어요.
        </p>
      </section>

      <section>
        <h2>4. 지식재산권과 출처</h2>
        <ul>
          <li>서비스의 디자인·문구에 대한 권리는 Trove에 있어요.</li>
          <li>앨범·공연 등 각 콘텐츠의 권리는 각 권리자에게 있어요. Trove는 일정 정보와 출처 링크만 보여 줘요.</li>
          <li>출처 표시를 지우거나, Trove를 자동 수집해 다른 서비스에 쓰는 것은 안 돼요.</li>
        </ul>
      </section>

      <section>
        <h2>5. 하지 말아야 할 일</h2>
        <ul>
          <li>서비스를 방해하는 일 (과도한 자동 요청, 취약점 악용 등)</li>
          <li>다른 사람이나 단체를 사칭하는 일</li>
          <li>법령을 위반하는 일</li>
        </ul>
      </section>

      <section>
        <h2>6. 서비스 변경과 중단</h2>
        <p>Trove는 MVP예요. 기능이 바뀌거나 중단될 수 있어요. 중요한 변경은 서비스 안에서 미리 알려요.</p>
      </section>

      <section>
        <h2>7. 책임의 한계</h2>
        <p>정보 오류로 생긴 손해에 대해 Trove에 고의나 중대한 과실이 없으면 책임지지 않아요. 다만 소비자 보호 법령이 이 약관보다 우선해요.</p>
      </section>

      <section>
        <h2>8. 준거법</h2>
        <p>이 약관은 대한민국 법을 따라요.</p>
      </section>

      <section>
        <h2>9. 시행일</h2>
        <p>미정이에요. 정식 공개 때 정해요.</p>
      </section>

      <p className="info-related">
        함께 보기: <Link to="/privacy">개인정보 처리방침</Link> · <Link to="/about">Trove 소개</Link>
      </p>
      <footer className="info-footer">Trove MVP</footer>
    </InfoLayout>
  );
}

export function PrivacyPage() {
  useInfoView("privacy");
  return (
    <InfoLayout title="개인정보 처리방침" eyebrow="PRIVACY" draft updatedAt={UPDATED_AT}>
      <section>
        <h2>1. 어떤 정보를 다루나요</h2>
        <p>지금 단계에서 Trove가 다루는 정보는 이게 전부예요.</p>
        <ul>
          <li>관심사</li>
          <li>담은 기다림과 알림 설정</li>
          <li>로그인에 쓴 이메일 (데모)</li>
          <li>앱 안 사용 기록 (앱을 연 기록, 본 화면, 검색어, 팔로우·담기·알림 같은 행동과 그 대상인 일정·아티스트·카테고리 ID, 로그인 방식, 잘못 연 주소)</li>
          <li>사용 기록에 함께 붙는 정보: 이름 없는 임시 계정 ID, 이 브라우저의 무작위 기기 ID, 방문 ID, 앱 버전, 홈 화면 앱으로 열었는지, 브라우저 종류 요약(운영체제, 브라우저 계열, 카카오톡·인스타그램 같은 앱 안 브라우저인지)</li>
        </ul>
        <p>관심사, 담은 기다림, 알림 설정 목록 자체와 데모 로그인에 쓴 이메일은 이 기기의 브라우저(localStorage)에만 저장해요. 다만 팔로우·담기·알림 켜기 같은 행동은 어떤 일정·아티스트·카테고리인지(ID)와 함께 사용 기록으로 Trove 서버에 가요.</p>
        <p>앱 안 사용 기록과 함께 붙는 정보는 Trove 서버(Supabase, 서울 리전)에 저장해요. 처음 열 때 브라우저마다(Safari와 홈 화면 앱도 따로) 이름 없는 임시 계정이 하나 생기고, 기록은 그 계정에 묶여요. 이름과 이메일은 사용 기록에 넣지 않아요.</p>
        <p>사용 기록에는 IP 주소와 브라우저 전체 정보(User-Agent)를 넣지 않아요. 다만 임시 계정의 로그인을 처리하는 Supabase와 앱 화면을 내보내는 Vercel은 보안과 운영을 위해 접속 IP 주소와 브라우저 정보를 접속·인증 기록에 남길 수 있어요.</p>
      </section>

      <section>
        <h2>2. 왜 쓰나요</h2>
        <ul>
          <li>관심사로 취향 피드를 구성해요.</li>
          <li>담은 기다림과 알림 설정으로 알림 시점을 계산해요.</li>
          <li>사용 기록으로 어떤 화면과 기능이 쓸모 있는지 보고 서비스를 개선해요.</li>
          <li>임시 계정·기기 ID와 브라우저 종류 요약으로 같은 사람의 기록을 이어 보고, 홈 화면 앱이나 앱 안 브라우저에서 문제가 없는지 확인해요.</li>
        </ul>
      </section>

      <section>
        <h2>3. 어디에 얼마나 보관하나요</h2>
        <p>이 기기에 저장한 정보는 이 기기의 브라우저에, 사용자가 지울 때까지 보관해요.</p>
        <p>사용 기록은 Supabase의 서울 리전(대한민국) 서버에, 사용자가 지울 때까지 보관해요. 테스트가 끝난 뒤의 보관 기간은 정해지는 대로 여기에 적을게요.</p>
        <p>지우는 방법은 두 가지예요.</p>
        <ul>
          <li>
            <Link to="/profile">프로필</Link> &gt; MVP 데이터 초기화: 이 브라우저(또는 홈 화면 앱)에 저장한 정보와 함께, 여기서 남긴 사용 기록을 Trove 서버에서도 지워요. Safari, 홈 화면 앱, 카카오톡 같은 앱 안 브라우저는 저장 공간과 임시 계정이 따로라서 각각에서 초기화해야 해요. 인터넷이 안 될 때는 다음에 앱을 열 때 마저 지워요. 기록이 빈 임시 계정 ID는 남아요.
          </li>
          <li>브라우저 설정에서 이 사이트의 데이터 삭제: 이 기기의 정보만 지워져요. 서버의 사용 기록까지 지우려면 먼저 MVP 데이터 초기화를 해 주세요.</li>
        </ul>
        <p>브라우저 데이터를 지우거나(시크릿 창을 닫을 때 포함) 브라우저가 이 사이트의 저장 공간을 스스로 비우면(예: Safari에서 한동안 이 사이트를 열지 않았을 때) 다음에 열 때 새 임시 계정이 생기고, 그 전 임시 계정에 남은 사용 기록은 앱에서 더는 지울 수 없어요. 이런 기록을 어떻게 정리할지는 보관 기간과 함께 정해지는 대로 여기에 적을게요.</p>
      </section>

      <section>
        <h2>4. 제3자 제공·위탁</h2>
        <p>개인정보를 다른 곳에 팔거나 넘기지 않아요(제3자 제공 없음). 서비스를 돌리려고 아래 회사에 처리를 맡겨요(위탁).</p>
        <ul>
          <li>Supabase Inc.: 데이터베이스와 임시 계정 로그인. 사용 기록과 함께 붙는 정보를 저장해요.</li>
          <li>Vercel Inc.: 웹 호스팅. 앱 화면을 내보내면서 접속 기록(IP 주소 등)을 처리해요.</li>
        </ul>
        <p>국외 이전: 두 회사 모두 미국 회사예요. 사용 기록은 서울 리전에 저장하지만 운영·장애 대응 중에 해외에서 접근될 수 있고, Vercel은 여러 나라의 서버로 화면을 내보내요.</p>
        <ul>
          <li>받는 곳: Supabase Inc.(미국), Vercel Inc.(미국)</li>
          <li>항목: 1번의 사용 기록과 함께 붙는 정보, 접속·인증 기록</li>
          <li>시기와 방법: 앱을 쓰는 동안 인터넷으로 암호화(HTTPS)해 보내요</li>
          <li>목적과 보관 기간: 2번·3번과 같아요</li>
          <li>거부 방법: MVP 데이터 초기화로 서버의 사용 기록을 지우거나 앱을 쓰지 않으면 돼요. 사용 기록을 보내지 않고 쓰는 방법은 아직 없어요.</li>
        </ul>
        <p>일정 상세의 출처 링크를 누르면 그 사이트로 이동하고, 그때부터는 그 사이트의 방침이 적용돼요.</p>
      </section>

      <section>
        <h2>5. 쿠키와 분석 도구</h2>
        <p>현재 외부 분석 도구와 광고 쿠키를 쓰지 않아요. 도입할 때는 미리 알리고 동의를 받아요.</p>
        <p>대신 앱 안 사용 기록은 Trove가 직접 Trove 서버에 모아요(1번). 검색어도 기록하는데, 앞 100자까지만 남겨요. 임시 계정의 로그인 상태는 쿠키가 아니라 이 브라우저의 localStorage에 저장해요.</p>
      </section>

      <section>
        <h2>6. 브라우저 알림 권한</h2>
        <p>사용자가 프로필에서 브라우저 알림을 켤 때만 권한을 요청해요. 언제든 브라우저 설정에서 끌 수 있어요.</p>
      </section>

      <section>
        <h2>7. 만 14세 미만</h2>
        <p>Trove는 만 14세 이상을 대상으로 해요. 만 14세 미만의 정보는 모으지 않아요.</p>
      </section>

      <section>
        <h2>8. 권리와 문의</h2>
        <p>내 정보 열람·삭제는 앱 안에서 바로 할 수 있어요. 문의처는 준비 중이에요.</p>
        <p>위의 열람·삭제는 이 기기에 저장한 정보 이야기예요. Trove 서버의 사용 기록은 앱 안에서 볼 수는 없지만, 기록을 남긴 브라우저(또는 홈 화면 앱)에서 MVP 데이터 초기화로 바로 지울 수 있어요. 다만 브라우저 데이터를 지우거나 브라우저가 저장 공간을 비워 새 임시 계정이 생긴 뒤에는 그 전 기록을 지울 수 없어요(3번).</p>
      </section>

      <section>
        <h2>9. 변경 고지</h2>
        <p>방침이 바뀌면 이 페이지와 서비스 안 공지로 알려요.</p>
      </section>

      <section>
        <h2>10. 시행일</h2>
        <p>미정이에요.</p>
      </section>

      <p className="info-related">
        함께 보기: <Link to="/terms">이용약관</Link> · <Link to="/about">Trove 소개</Link>
      </p>
      <footer className="info-footer">Trove MVP</footer>
    </InfoLayout>
  );
}
