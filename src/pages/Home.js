import { AiFillPhone } from "react-icons/ai";
import { HiEnvelope } from "react-icons/hi2";

export default function Home() {
  return (
    <div className="top-banner-container">
      <section className="pressure-washing-title"><span>PURE</span> CLEANING PRESSURE CLEANING</section>
      <section>Family owned and operated in South Florida for over 30 years</section>
      <section className="pressure-washing-quote">Give us a call or email for a quick quote</section>
      <section className="contact-buttons">
        <a className="contact-link" href="tel:example"><AiFillPhone className="phone-icon"/>&nbsp; (954) 389-2642</a>
        <a className="contact-link" href="mailto: pure_cleaning@live.com"><HiEnvelope className="email-icon"/>&nbsp; Get a Quote</a>
      </section>
    </div>
  );
}
