import { AiFillInstagram, AiFillPhone } from "react-icons/ai";
import { HiEnvelope } from "react-icons/hi2";

export default function Header() {
  function scrollToQuote(e) {
    e.preventDefault();
    const el = document.getElementById('quote-form');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <nav className="header-wrapper">
      <div>
        <h1 className="logo">
        <img className="logo" src="https://i.imgur.com/1lIyuLS.png" alt="Pure Cleaning logo"></img>
        </h1>
      </div>
      <ul className="header-nav-links">
        <li>
          <a href="#quote-form" onClick={scrollToQuote} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span style={{ fontSize: '1.1rem' }}>📋</span>
            <h6>Get a Quote</h6>
          </a>
        </li>
        <li>
          <a
            href="https://www.instagram.com/purecleaningpressurecleaning/"
            target="_blank"
            rel="noreferrer"
          >
            <AiFillInstagram />
            <h6>Social</h6>
          </a>
        </li>
        <li>
          <a href="mailto: pure_cleaning@live.com">
            <HiEnvelope className="email-icon" />
            <h6>Email</h6>
          </a>
        </li>
        <li>
          <a href="tel:+19543892642">
            <AiFillPhone />
            <h6>Call</h6>
          </a>
        </li>
      </ul>
    </nav>
  );
}
