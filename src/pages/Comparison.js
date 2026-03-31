import React from "react";
import ReactBeforeSliderComponent from "react-before-after-slider-component";
import "react-before-after-slider-component/dist/build.css";

export default function Comparison() {
  const FIRST_IMAGE = {
    imageUrl: "https://i.imgur.com/InNJ2Jv.jpg",
  };
  const SECOND_IMAGE = {
    imageUrl: "https://i.imgur.com/BCUOweg.jpg",
  };
  const THIRD_IMAGE = {
    imageUrl: "https://i.imgur.com/zgQemH6.jpg",
  };
  const FOURTH_IMAGE = {
    imageUrl: "https://i.imgur.com/VSeTR7N.jpg",
  };
  const FIFTH_IMAGE = {
    imageUrl: "https://i.imgur.com/mm64NW3.jpg",
  };
  const SIXTH_IMAGE = {
    imageUrl: "https://i.imgur.com/X6xAAnF.jpg",
  };
  const SEVENTH_IMAGE = {
    imageUrl: "https://imgur.com/bPv7zi7.jpg",
  };
  const EIGHTH_IMAGE = {
    imageUrl: "https://imgur.com/xG29OZM.jpg",
  };
  const NINTH_IMAGE = {
    imageUrl: "https://imgur.com/gprkyAX.jpg",
  };
  const TENTH_IMAGE = {
    imageUrl: "https://imgur.com/LCeJyBG.jpg",
  };
  const ELEVENTH_IMAGE = {
    imageUrl: "https://imgur.com/qm4JMFA.jpg",
  };
  const TWELFTH_IMAGE = {
    imageUrl: "https://imgur.com/ArFhDAL.jpg",
  };

  return (
    <div className="results-container">
      <section className="slider-title">See the Results</section>
      <div className="comparison-container">
        <div className="slider">
          <ReactBeforeSliderComponent
            firstImage={FIRST_IMAGE}
            secondImage={SECOND_IMAGE}
          />
        </div>
        <div className="slider">
          <ReactBeforeSliderComponent
            firstImage={THIRD_IMAGE}
            secondImage={FOURTH_IMAGE}
          />
        </div>
        <div className="slider">
          <ReactBeforeSliderComponent
            firstImage={FIFTH_IMAGE}
            secondImage={SIXTH_IMAGE}
          />
        </div>
        <div className="slider">
          <ReactBeforeSliderComponent
            firstImage={SEVENTH_IMAGE}
            secondImage={EIGHTH_IMAGE}
          />
        </div>
        <div className="slider">
          <ReactBeforeSliderComponent
            firstImage={NINTH_IMAGE}
            secondImage={TENTH_IMAGE}
          />
        </div>
        <div className="slider">
          <ReactBeforeSliderComponent
            firstImage={ELEVENTH_IMAGE}
            secondImage={TWELFTH_IMAGE}
          />
        </div>
      </div>
    </div>
  );
}
