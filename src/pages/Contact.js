import { FiPhone } from "react-icons/fi";

export default function Contact() {
  return (
    <div className="contact-wrapper">
      <section>Family Owned and Operated, Professional, Licensed, and Insured</section>
      <section>
        <a href="tel:example">
        <FiPhone />
        &nbsp; (954) 389-2642
        </a>
      </section>
    </div>
  );
}
