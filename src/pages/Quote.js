import React, { useRef, useState } from 'react';
import emailjs from 'emailjs-com';

export default function Quote() {
  const form = useRef();
  const [formData, setFormData] = useState({
    user_name: '',
    user_email: '',
    message: '',
  });

  const sendEmail = (e) => {
    e.preventDefault();

    emailjs
      .sendForm(
        'service_mldg2t8',
        'template_mn47acp',
        form.current,
        'kf9KEnKFIaFbIoUeI'
      )
      .then(
        (result) => {
          console.log(result.text);
          setFormData({
            user_name: '',
            user_email: '',
            message: '',
          });
          alert('Message sent successfully!');
        },
        (error) => {
          console.log(error.text);
        }
      );
  };

  const handleInputChange = (event) => {
    const { name, value } = event.target;
    setFormData({
      ...formData,
      [name]: value,
    });
  };

  return (
    <div>
      <div className='quote-header'>Receive a Direct Quote</div>
      <div className='quote-container'>
    <form className='quote-form' ref={form} onSubmit={sendEmail}>
      <label>Full Name:</label>
      <input
        type="text"
        name="user_name"
        value={formData.user_name}
        onChange={handleInputChange}
      />
      <label>Your Email:</label>
      <input
        type="email"
        name="user_email"
        value={formData.user_email}
        onChange={handleInputChange}
      />
       <label>Phone Number:</label>
      <input
        type="phone"
        name="user_phone"
        value={formData.user_phone}
        onChange={handleInputChange}
      />
      <label>Project Description:</label>
      <textarea
        name="message"
        value={formData.message}
        onChange={handleInputChange}
      />
      <input className="send-button" type="submit" value="Send" />
    </form>
    <image url="https://imgur.com/UJ4w2Eg.jpg"></image>
    </div>
    </div>
  );
};