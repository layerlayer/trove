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
const UPDATED_AT = "2026-10-17";

/** 출처 안내에 거는 바깥 링크. Steam 약관 때문에 rel 에 nofollow 를 넣지 않는다 */
const LINKS = {
  ccBySa: "https://creativecommons.org/licenses/by-sa/4.0/",
  wikiMusic2026: "https://en.wikipedia.org/wiki/2026_in_South_Korean_music",
  wikiGames2026: "https://en.wikipedia.org/wiki/List_of_video_games_released_in_2026",
  wikiGames2027: "https://en.wikipedia.org/wiki/List_of_video_games_released_in_2027",
  kmdb: "https://www.kmdb.or.kr",
} as const;

function ExternalText({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

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
          <li>예매처 공지, 스토어, 게임사 보도자료, 공개된 일정 데이터에서 하루 한 번 일정을 모아요. 어디서 모았는지는 아래 ‘출처’에서 볼 수 있어요.</li>
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
        <p>Trove는 이런 곳에서 일정을 모아요.</p>
        <ul>
          <li>공연 티켓오픈: 티켓링크</li>
          <li>음악: kpopping, Ktown4u, 위키백과</li>
          <li>게임: 위키백과, Steam, App Store, 게임사 보도자료(컴투스, 스마일게이트 뉴스룸, 뉴스와이어). 안드로이드 출시 여부는 Google Play 페이지로 확인해요.</li>
          <li>영화: 한국영상자료원 KMDb</li>
        </ul>
        <p>게임·영화 출처는 차례로 붙이는 중이라, 아래 목록에 아직 없는 곳도 있어요.</p>
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
        <h2>출처에서 가져오는 것</h2>
        <p>일정에 보여 주는 건 날짜, 제목, 아티스트·게임사 이름, 플랫폼, 공연장 같은 사실 정보와 원문 링크뿐이에요. 출처의 이미지 파일과 설명문은 저장하거나 싣지 않아요.</p>
        <p>모은 정보는 대한민국에 있는 Trove 운영 장비에 저장해요. 발행한 일정은 앱을 보여 주는 웹 호스팅(Vercel)과 코드 저장소(GitHub)에도 올라가요.</p>
        {/* 아래 첫 문단은 모바일게임 출처 결정 메모(2026-10-17) §3 하단 문구 그대로. 게임물관리위원회 문장은 그 출처를 아직 안 써서 뺐다 */}
        <p>출시일·플랫폼 정보는 각 게임사·스토어의 공식 발표를 바탕으로 정리한 사실 정보이며, 일정은 사전 공지 없이 바뀔 수 있어요. 정확한 내용은 각 출처 링크에서 확인해 주세요.</p>
        <p>공연·음악·영화 일정도 주최사·발매사·배급사 사정으로 바뀔 수 있어요.</p>
        <p>App Store에서 모은 게임의 출시 예정일은 App Store 표기 기준이며 하루 정도 차이가 나거나 변경될 수 있어요.</p>
      </section>

      <section>
        <h2>라이선스와 상표</h2>
        <p>
          음악·게임 일정 중 일부는 영어 위키백과의 연도별 한국 음악 문서(예:{" "}
          <ExternalText href={LINKS.wikiMusic2026}>‘2026 in South Korean music’</ExternalText>)와{" "}
          <ExternalText href={LINKS.wikiGames2026}>‘List of video games released in 2026’</ExternalText>·
          <ExternalText href={LINKS.wikiGames2027}>‘List of video games released in 2027’</ExternalText> 문서를 바탕으로 정리했어요. 이 문서들은{" "}
          <ExternalText href={LINKS.ccBySa}>CC BY-SA 4.0</ExternalText> 라이선스로 공개돼 있어요. 위키백과에서 온 일정의 상세에는 ‘(CC BY-SA 4.0)’ 표시와 해당 문서 링크가 붙어요.
        </p>
        <p>PC 게임 일정 중 일부는 Steam 상점에 공개된 정보를 바탕으로 정리했어요.</p>
        {/* 영화 출처 결정 메모(2026-10-16) 문구 그대로. 공공누리 유형은 한국영상자료원의 서면 확인 전까지 "확인 대기" */}
        <p>
          본 서비스의 영화 개봉 정보는 한국영상자료원이 공공누리 제1유형으로 개방한 'KMDb 영화상세정보'를 이용하였으며, 해당 정보는 한국영상자료원 KMDb(
          <ExternalText href={LINKS.kmdb}>https://www.kmdb.or.kr</ExternalText>)에서 확인하실 수 있습니다.
        </p>
        {/* Google Play 문장은 콘솔 README(Google Play 확인) 앱 쪽 문구를 해요체로. 모바일게임 메모 하단 문구는 "Google Play는 Google LLC의 상표입니다" */}
        <p>App Store는 Apple Inc.의 서비스표예요. Google Play 및 Google Play 로고는 Google LLC의 상표예요.</p>
        <p>Trove는 Valve, Steam, 위키미디어 재단을 비롯해 출처로 쓰는 회사·단체와 관련이 없고, 이들의 보증을 받지 않았어요.</p>
      </section>

      <section>
        <h2>내 데이터</h2>
        <p>관심사·담은 기다림·알림 설정은 지금 이 기기의 브라우저에만 저장돼요. 서버 계정은 준비 중이에요.</p>
        <p>
          <Link to="/profile">프로필</Link> &gt; MVP 데이터 초기화로 언제든 지울 수 있어요.
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
          <li>정보는 각 출처(예매처 공지, 스토어, 게임사 보도자료, 공개된 일정 데이터 등)를 기준으로 하지만, 주최사·발매사·게임사·배급사 사정으로 사전 공지 없이 바뀔 수 있어요. Trove가 정확성·완전성을 보증하지는 않아요.</li>
          <li>예매·구매는 각 출처에서 이루어져요. Trove는 거래 당사자가 아니에요.</li>
          <li>알림은 참고용이에요. 기기나 브라우저 상태에 따라 울리지 않을 수도 있어요.</li>
        </ul>
      </section>

      <section>
        <h2>3. 계정과 데이터</h2>
        <p>지금 단계에서 로그인과 저장 데이터(관심사, 담은 기다림, 알림 설정)는 이 기기 안에서만 동작해요. 서버로 보내지 않아요.</p>
        <p>기기나 브라우저 데이터를 지우면 함께 사라져요. 지운 데이터는 되돌리기 어려워요.</p>
        <p>
          어떤 정보를 어떻게 다루는지는 <Link to="/privacy">개인정보 처리방침</Link>에서 볼 수 있어요.
        </p>
      </section>

      <section>
        <h2>4. 지식재산권과 출처</h2>
        <ul>
          <li>서비스의 디자인·문구에 대한 권리는 Trove에 있어요.</li>
          <li>앨범·공연·게임·영화 등 각 콘텐츠와 그 이름·상표의 권리는 각 권리자에게 있어요. Trove는 날짜·제목·플랫폼 같은 일정 정보와 출처 링크만 보여 주고, 이미지와 설명문은 싣지 않아요.</li>
          <li>
            일정 정보는 출처마다 정한 조건에 맞춰 출처를 밝혀요. 위키백과에서 온 정보는 CC BY-SA 4.0, 한국영상자료원 KMDb에서 온 정보는 공공누리 제1유형 조건을 따라요. 자세한 내용은{" "}
            <Link to="/about">Trove 소개</Link>의 ‘출처’와 ‘라이선스와 상표’에서 볼 수 있어요.
          </li>
          <li>Trove는 출처로 쓰는 회사·단체와 관련이 없고, 이들의 보증을 받지 않았어요.</li>
          <li>출처 표시를 지우거나, Trove를 자동 수집해 다른 서비스에 쓰는 것은 안 돼요. 다만 위키백과에서 온 정보는 원래 라이선스(CC BY-SA 4.0) 조건대로 쓸 수 있어요.</li>
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
          <li>앱 안 사용 기록 (본 화면, 검색어, 담기·알림 같은 행동, 로그인 방식, 잘못 연 주소)</li>
        </ul>
        <p>모두 브라우저 localStorage에만 저장되고, 서버로 보내지 않아요.</p>
      </section>

      <section>
        <h2>2. 왜 쓰나요</h2>
        <ul>
          <li>관심사로 취향 피드를 구성해요.</li>
          <li>담은 기다림과 알림 설정으로 알림 시점을 계산해요.</li>
          <li>사용 기록으로 어떤 화면과 기능이 쓸모 있는지 보고 서비스를 개선해요.</li>
        </ul>
      </section>

      <section>
        <h2>3. 어디에 얼마나 보관하나요</h2>
        <p>이 기기의 브라우저에, 사용자가 지울 때까지 보관해요. 지우는 방법은 두 가지예요.</p>
        <ul>
          <li>
            <Link to="/profile">프로필</Link> &gt; MVP 데이터 초기화
          </li>
          <li>브라우저 설정에서 이 사이트의 데이터 삭제</li>
        </ul>
      </section>

      <section>
        <h2>4. 제3자 제공·위탁</h2>
        <p>없어요. 일정 상세의 출처 링크를 누르면 그 사이트로 이동하고, 그때부터는 그 사이트의 방침이 적용돼요.</p>
      </section>

      <section>
        <h2>5. 일정 정보는 어디에 저장하나요</h2>
        <p>일정 정보는 개인정보가 아니지만, 어디에 두는지 함께 알려 드려요.</p>
        <ul>
          <li>티켓링크, 위키백과, Steam, App Store, 한국영상자료원 KMDb 같은 출처에서 모은 날짜·제목·플랫폼 같은 사실 정보와 원문 링크는 대한민국에 있는 Trove 운영 장비에 저장해요.</li>
          <li>발행한 일정은 앱을 보여 주는 웹 호스팅(Vercel)과 코드 저장소(GitHub)에도 올라가요.</li>
          <li>출처의 이미지 파일과 설명문은 저장하지 않아요. 검수할 때 보려고 이미지 주소와 원문 속 짧은 근거 문장만 운영 장비에 남겨요.</li>
        </ul>
        <p>
          출처별 안내는 <Link to="/about">Trove 소개</Link>의 ‘출처’에서 볼 수 있어요.
        </p>
      </section>

      <section>
        <h2>6. 쿠키와 분석 도구</h2>
        <p>현재 외부 분석 도구와 광고 쿠키를 쓰지 않아요. 도입할 때는 미리 알리고 동의를 받아요.</p>
      </section>

      <section>
        <h2>7. 브라우저 알림 권한</h2>
        <p>사용자가 프로필에서 브라우저 알림을 켤 때만 권한을 요청해요. 언제든 브라우저 설정에서 끌 수 있어요.</p>
      </section>

      <section>
        <h2>8. 만 14세 미만</h2>
        <p>Trove는 만 14세 이상을 대상으로 해요. 만 14세 미만의 정보는 모으지 않아요.</p>
      </section>

      <section>
        <h2>9. 권리와 문의</h2>
        <p>내 정보 열람·삭제는 앱 안에서 바로 할 수 있어요. 문의처는 준비 중이에요.</p>
      </section>

      <section>
        <h2>10. 변경 고지</h2>
        <p>방침이 바뀌면 이 페이지와 서비스 안 공지로 알려요.</p>
      </section>

      <section>
        <h2>11. 시행일</h2>
        <p>미정이에요.</p>
      </section>

      <p className="info-related">
        함께 보기: <Link to="/terms">이용약관</Link> · <Link to="/about">Trove 소개</Link>
      </p>
      <footer className="info-footer">Trove MVP</footer>
    </InfoLayout>
  );
}
